// Greeter — 中文 and 😀 in a comment to exercise wide/astral display columns.
export class Greeter {
  constructor(private readonly name: string) {}
  greet(): string {
    return `Hello, ${this.name}!`;
  }
}
