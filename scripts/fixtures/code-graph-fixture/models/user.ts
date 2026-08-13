// 用户模型
export class User {
  constructor(public name: string) {}

  greet(): string {
    return `hi ${this.name}`;
  }

  private secret(): number {
    return 1;
  }
}

export function createUser(name: string): User {
  return new User(name);
}
