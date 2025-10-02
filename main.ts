import { dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import {
  Computed,
  handleInput,
  handleMouseControls,
  Signal,
  Tui,
} from "https://deno.land/x/tui@2.1.11/mod.ts";
import { debounce } from "jsr:@std/async@1.0.14/debounce";
import { propagateOnSetHandler } from "./logic/signal-helpers.ts";
import {
  readTodosFromFile,
  writeTodosToFile,
} from "./logic/todo-file-helpers.ts";
import { Todo } from "./logic/todo.ts";
import { Todos } from "./logic/Todos.ts";
import { ActionBar } from "./ui/action-bar.ts";
import confirmDialog from "./ui/confirm-dialog.ts";
import dateSelector from "./ui/date-selector.ts";
import recurrenceDialog from "./ui/recurrence-dialog.ts";
import editTodo from "./ui/edit-todo.ts";
import recurrenceAmountDialog from "./ui/recurrence-amount-dialog.ts";
import { TodoList } from "./ui/todo-list.ts";
import { disableComponent } from "./ui/tui-helpers.ts";

if (Deno.args.length < 1) {
  console.error("Please provide a filename as an argument.");
  Deno.exit(1);
}

// This flag is set when watcher just fetched file
const justReadFileFlag = new Signal<boolean>(false);

const tui = new Tui({
  style: crayon.bgBlack, // Make background black
  refreshRate: 1000 / 60, // Run in 60FPS
});
const filename = Deno.args[0];
const initialTodoList = await readTodosFromFile(filename);
const todosOrig: Signal<Todos> = new Signal(new Todos(), {
  deepObserve: true,
  watchObjectIndex: true,
});
todosOrig.value = new Todos(
  ...initialTodoList.map((x) => new Proxy(x, propagateOnSetHandler(todosOrig))),
);
// When todo changes -> pauze watcher, write to file, reenable watcher
const writeTodosDebounced = debounce(async (todos: Todo[]) => {
  if (justReadFileFlag.value) {
    justReadFileFlag.value = false;
    return;
  }
  await writeTodosToFile(todos, filename);
}, 50);

todosOrig.subscribe((todos: Todo[]) => {
  writeTodosDebounced(todos);
});
const todosSorted = new Computed(
  () =>
    todosOrig.value
      .sortByImportance()
      .filterHidden(),
);
handleInput(tui);
handleMouseControls(tui);
// handleKeyboardControls(tui);
tui.dispatch();
tui.run();

let todoList: TodoList | undefined = undefined;
let actionBar: ActionBar | undefined = undefined;

const disableUiWhile = <T, Args extends unknown[]>(
  func: (...args: Args) => Promise<T>,
): (...args: Args) => Promise<T | undefined> =>
async (...args: Args) => {
  const disableTodoList = disableComponent(todoList!);
  const disableActionBar = disableComponent(actionBar!);
  try {
    return await func(...args);
  } catch (_) {
    // Catch cancel of modals
  } finally {
    disableTodoList.abort();
    disableActionBar.abort();
  }
};

const archiveCallback = disableUiWhile(async () => {
  const completedTodos = todosOrig.value.filter((x) => x.isDone());
  await confirmDialog(
    `Archive ${completedTodos.length} completed todos to done.txt?`,
    tui,
  );
  await writeTodosToFile(
    completedTodos,
    dirname(filename) + "/done.txt",
    {
      append: true,
      create: true,
    },
  );
  todosOrig.value = new Todos(...todosOrig.peek().filter((x) => !x.isDone()));
});

todoList = new TodoList({
  parent: tui,
  data: todosSorted,
  rectangle: new Computed(() => ({
    column: 0,
    row: 0,
    height: tui.rectangle.value.height - 2,
    width: tui.rectangle.value.width,
  })),
  zIndex: 1,
  editCallback: disableUiWhile(async (todo: Todo) => {
    const text = await editTodo(todo.text, tui);
    return todo.setText(text);
  }),
  newCallback: disableUiWhile(async () => {
    const text = await editTodo("", tui);
    const temp = new Todo(text);
    if (!temp.creationDate) {
      temp.creationDate = new Date();
    }
    const todo = new Proxy(temp, propagateOnSetHandler(todosOrig));
    todosOrig.value = new Todos(...todosOrig.value, todo);
    return todo;
  }),
  archiveCallback,
  dueCallback: disableUiWhile(async (todo: Todo): Promise<void> => {
    const date = await dateSelector("Due date", tui);
    return todo.setDue(date);
  }),
  thresholdCallback: disableUiWhile(async (todo: Todo): Promise<void> => {
    const date = await dateSelector("Threshold date", tui);
    return todo.setThreshold(date);
  }),
  deleteCallback: disableUiWhile(async (todo: Todo): Promise<void> => {
    await confirmDialog("Delete todo?", tui);
    todosOrig.value = new Todos(...todosOrig.value.filter((x) => x !== todo));
  }),
  toggleHiddenCallback: disableUiWhile(async (todo: Todo): Promise<void> => {
    if (!todo.isHidden()) {
      await confirmDialog("Hide todo?", tui);
    }
    todo.toggleHidden();
  }),
  toggleStateCallback: (todo: Todo) => {
    const newTodo = todo.toggleState();
    if (newTodo) {
      todosOrig.value = new Todos(...todosOrig.peek(), newTodo);
    }
  },
  recurrenceCallback: disableUiWhile(async (todo: Todo): Promise<void> => {
    const recurrence = await recurrenceDialog("Recurrence", tui);

    const amount = await recurrenceAmountDialog(
      "",
      tui,
      recurrence,
    );
    todo.setRecurrence(`${amount}${recurrence}`);
  }),
});
todoList.state.value = "focused";

actionBar = new ActionBar({
  parent: tui,
  rectangle: new Computed(() => ({
    column: 0,
    row: tui.rectangle.value.height - 2,
    height: 2,
    width: tui.rectangle.value.width,
  })),
  zIndex: 1,
  newCallback: disableUiWhile(async () => {
    const text = await editTodo("", tui);
    const temp = new Todo(text);
    if (!temp.creationDate) {
      temp.creationDate = new Date();
    }
    const todo = new Proxy(temp, propagateOnSetHandler(todosOrig));
    todosOrig.value = new Todos(...todosOrig.value, todo);
    todoList.setSelectedTodo(todo);
  }),
  editCallback: disableUiWhile(async () => {
    const todo = todoList.getSelectedTodo();
    if (!todo) {
      return;
    }
    const text = await editTodo(todo.text, tui);
    return todo.setText(text);
  }),
  dueCallback: () => {},
  thresholdCallback: () => {},
  deleteCallback: () => {},
  toggleHiddenCallback: () => {},
  archiveCallback,
});

const readTodosDebounced = debounce(
  async () => {
    justReadFileFlag.value = true;
    const todosFromFile = await readTodosFromFile(filename);
    todosOrig.value = new Todos(
      ...todosFromFile.map((x) =>
        new Proxy(x, propagateOnSetHandler(todosOrig))
      ),
    );
  },
  500,
);

const openTodoFileWatcher = async (filename: string) => {
  try {
    await Deno.stat(filename); // Check if file exists
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      await Deno.writeTextFile(filename, ""); // Create the file if it doesn't exist
    } else {
      throw error; // Re-throw other errors from stat()
    }
  }

  const watcher = Deno.watchFs(filename);
  for await (const event of watcher) {
    if (event.kind === "modify") {
      readTodosDebounced();
    }
  }
};
await openTodoFileWatcher(filename);
