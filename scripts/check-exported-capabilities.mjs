#!/usr/bin/env node

// Exported stateless behavior must be published through a namespace+Static capability seam.
// TypeScript's checker lets this gate distinguish callable behavior from genuine exported data,
// including callable aliases whose syntax alone does not reveal their type.

import { createRequire } from 'node:module';
import { relative, resolve, sep } from 'node:path';

const requireFromProject = createRequire(import.meta.url);
const typescript = requireFromProject('typescript');

const projectRoot = process.cwd();
const configurationPath = typescript.findConfigFile(
  projectRoot,
  typescript.sys.fileExists,
  'tsconfig.json',
);

if (configurationPath === undefined) {
  process.stderr.write('exported-capability check: tsconfig.json not found\n');
  process.exit(2);
}

const configurationRead = typescript.readConfigFile(configurationPath, typescript.sys.readFile);
if (configurationRead.error !== undefined) {
  process.stderr.write(
    `${typescript.formatDiagnostic(configurationRead.error, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => projectRoot,
      getNewLine: () => '\n',
    })}\n`,
  );
  process.exit(2);
}

const parsedConfiguration = typescript.parseJsonConfigFileContent(
  configurationRead.config,
  typescript.sys,
  projectRoot,
);
const program = typescript.createProgram({
  rootNames: parsedConfiguration.fileNames,
  options: parsedConfiguration.options,
});
const typeChecker = program.getTypeChecker();
const modulesRootPrefix = `${resolve(projectRoot, 'src/modules')}${sep}`;

function hasModifier(node, modifierKind) {
  return node.modifiers?.some((modifier) => modifier.kind === modifierKind) ?? false;
}

function isModuleSource(sourceFile) {
  const absoluteFileName = resolve(sourceFile.fileName);
  if (!absoluteFileName.startsWith(modulesRootPrefix) || sourceFile.isDeclarationFile) return false;
  const projectRelativeFileName = relative(projectRoot, absoluteFileName);
  return (
    !projectRelativeFileName.includes(`${sep}__tests__${sep}`) &&
    !/\.test\.[cm]?tsx?$/.test(projectRelativeFileName)
  );
}

function unwrapExpression(expression) {
  let currentExpression = expression;
  while (
    typescript.isParenthesizedExpression(currentExpression) ||
    typescript.isAsExpression(currentExpression) ||
    typescript.isTypeAssertionExpression(currentExpression) ||
    typescript.isSatisfiesExpression(currentExpression) ||
    typescript.isNonNullExpression(currentExpression)
  ) {
    currentExpression = currentExpression.expression;
  }
  return currentExpression;
}

function isFunctionExpression(expression) {
  const unwrappedExpression = unwrapExpression(expression);
  return (
    typescript.isArrowFunction(unwrappedExpression) ||
    typescript.isFunctionExpression(unwrappedExpression)
  );
}

function callableTypeAt(node) {
  const type = typeChecker.getTypeAtLocation(node);
  return typeChecker.getSignaturesOfType(type, typescript.SignatureKind.Call).length > 0;
}

function resolvedSymbolAt(node) {
  const symbol = typeChecker.getSymbolAtLocation(node);
  if (symbol === undefined) return undefined;
  if ((symbol.flags & typescript.SymbolFlags.Alias) !== 0) {
    return typeChecker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function callableSymbolAt(node) {
  const symbol = resolvedSymbolAt(node);
  if (symbol === undefined) return false;
  const type = typeChecker.getTypeOfSymbolAtLocation(symbol, node);
  return typeChecker.getSignaturesOfType(type, typescript.SignatureKind.Call).length > 0;
}

const violations = [];

function recordViolation(sourceFile, node, exportedName, exportShape) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  violations.push({
    fileName: relative(projectRoot, sourceFile.fileName),
    line: position.line + 1,
    column: position.character + 1,
    exportedName,
    exportShape,
  });
}

function inspectNode(sourceFile, node) {
  if (
    typescript.isFunctionDeclaration(node) &&
    hasModifier(node, typescript.SyntaxKind.ExportKeyword)
  ) {
    recordViolation(
      sourceFile,
      node,
      node.name?.text ?? 'default',
      hasModifier(node, typescript.SyntaxKind.AsyncKeyword)
        ? 'export async function'
        : 'export function',
    );
  }

  if (
    typescript.isVariableStatement(node) &&
    hasModifier(node, typescript.SyntaxKind.ExportKeyword)
  ) {
    for (const declaration of node.declarationList.declarations) {
      if (!typescript.isIdentifier(declaration.name)) continue;
      if (
        (declaration.initializer !== undefined && isFunctionExpression(declaration.initializer)) ||
        callableTypeAt(declaration.name)
      ) {
        recordViolation(
          sourceFile,
          declaration,
          declaration.name.text,
          'exported callable variable',
        );
      }
    }
  }

  if (
    typescript.isExportDeclaration(node) &&
    node.exportClause !== undefined &&
    typescript.isNamedExports(node.exportClause) &&
    !node.isTypeOnly
  ) {
    for (const exportSpecifier of node.exportClause.elements) {
      if (exportSpecifier.isTypeOnly || !callableSymbolAt(exportSpecifier.name)) continue;
      recordViolation(
        sourceFile,
        exportSpecifier,
        exportSpecifier.name.text,
        'callable export alias',
      );
    }
  }

  typescript.forEachChild(node, (childNode) => inspectNode(sourceFile, childNode));
}

for (const sourceFile of program.getSourceFiles()) {
  if (isModuleSource(sourceFile)) inspectNode(sourceFile, sourceFile);
}

violations.sort((left, right) =>
  left.fileName.localeCompare(right.fileName) ||
  left.line - right.line ||
  left.column - right.column,
);

if (violations.length > 0) {
  process.stderr.write(
    'Exported callable behavior must be indexed by a namespace+Static capability class:\n',
  );
  for (const violation of violations) {
    process.stderr.write(
      `${violation.fileName}:${violation.line}:${violation.column}: ` +
        `${violation.exportShape} '${violation.exportedName}'\n`,
    );
  }
  process.exit(1);
}

process.stdout.write('exported-capability check: PASS\n');
