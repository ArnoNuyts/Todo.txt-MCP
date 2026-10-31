export const TodoStateEnum = {
  todo: 1,
  done: 2,
} as const;

export type TodoStateEnum =
  (typeof TodoStateEnum)[keyof typeof TodoStateEnum];
