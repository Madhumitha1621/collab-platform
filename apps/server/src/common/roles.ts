import { registerEnumType } from '@nestjs/graphql';

export enum Role {
  OWNER = 'OWNER',
  EDITOR = 'EDITOR',
  VIEWER = 'VIEWER',
}

registerEnumType(Role, { name: 'Role' });

const RANK: Record<Role, number> = { [Role.VIEWER]: 1, [Role.EDITOR]: 2, [Role.OWNER]: 3 };

export function hasRole(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}
