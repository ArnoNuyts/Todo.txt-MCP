import { Signal } from "https://deno.land/x/tui@2.1.11/mod.ts";
import { Todo } from "./todo.ts";
import { Todos } from "./Todos.ts";

export const propagateOnSetHandler = (signal: Signal<Todos>) => ({
  set(obj: Todo, prop: Exclude<keyof Todo, 'id'>, value: never) {
    // The default behavior to store the value
    obj[prop] = value as never; // as never is a hack to make typescript shut up
    signal.propagate();

    // Indicate success
    return true;
  },
});
