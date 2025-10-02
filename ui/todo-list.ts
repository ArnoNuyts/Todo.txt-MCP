import { writeText } from "https://deno.land/x/copy_paste@v1.1.3/mod.ts";
import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import {
  BoxObject,
  clamp,
  Component,
  ComponentOptions,
  Computed,
  DrawObject,
  Signal,
  Style,
  TextObject,
} from "https://deno.land/x/tui@2.1.11/mod.ts";
import { debounce } from "jsr:@std/async@0.224.0/debounce";
import { Todo } from "../logic/todo.ts";
import { Todos } from "../logic/Todos.ts";
import { UpperCaseLetter } from "../types/types.ts";

enum IndexType {
  context,
  todo,
}
type ContextIndexEntry = {
  type: IndexType.context;
  todoCount: number;
  contextName: string;
};

type TodoIndexEntry = {
  type: IndexType.todo;
  todoNumber: number;
};

type IndexEntry = ContextIndexEntry | TodoIndexEntry;

export interface TableOptions extends Omit<ComponentOptions, "theme"> {
  archiveCallback: () => void;
  editCallback: (currentTodo: Todo) => void;
  dueCallback: (currentTodo: Todo) => void;
  thresholdCallback: (currentTodo: Todo) => void;
  deleteCallback: (currentTodo: Todo) => void;
  toggleHiddenCallback: (currentTodo: Todo) => void;
  toggleStateCallback: (currentTodo: Todo) => void;
  recurrenceCallback: (currentTodo: Todo) => void;
  newCallback: () => Promise<Todo | undefined>;
  data: Computed<Todos>;
}

export class TodoList extends Component {
  drawnRows: { [key: string]: DrawObject }[] = [];
  data: Signal<Todos>;
  selectedRow: Signal<number>;
  offsetRow: Signal<number>;
  numberPadding: Signal<number>;
  editCallback: (currentTodo: Todo) => void;
  dueCallback: (currentTodo: Todo) => void;
  thresholdCallback: (currentTodo: Todo) => void;
  deleteCallback: (currentTodo: Todo) => void;
  toggleHiddenCallback: (currentTodo: Todo) => void;
  toggleStateCallback: (currentTodo: Todo) => void;
  recurrenceCallback: (currentTodo: Todo) => void;
  newCallback: () => Promise<Todo | undefined>;
  lastSelectedId: symbol | undefined = undefined;
  archiveCallback: () => void;
  indexes: Computed<IndexEntry[]>;

  constructor(options: TableOptions) {
    super(options as unknown as ComponentOptions);

    this.data = options.data;
    this.indexes = new Computed(() => {
      const data = this.data.value;
      const indexArray: IndexEntry[] = [];
      let prevTodo: Todo | null = null;
      let currHeader: ContextIndexEntry | null = null;
      let currHeaderTodoCounter = 0;
      for (const index in data) {
        const currTodo = data[index];
        if (!currTodo?.id) {
          continue;
        }
        if (
          prevTodo === null ||
          currTodo?.contexts?.values().next().value !=
            prevTodo?.contexts?.values().next().value
        ) {
          // Set counter of prev header;
          if (currHeader) {
            currHeader.todoCount = currHeaderTodoCounter;
            currHeaderTodoCounter = 0;
          }

          currHeader = {
            type: IndexType.context,
            todoCount: 0,
            contextName: currTodo?.contexts?.values().next().value ?? "None",
          };
          indexArray.push(currHeader);
        }
        indexArray.push({ type: IndexType.todo, todoNumber: parseInt(index) });
        currHeaderTodoCounter++;
        prevTodo = currTodo;
      }
      if (currHeader) {
        currHeader.todoCount = currHeaderTodoCounter;
      }
      return indexArray;
    });

    this.selectedRow = new Signal(1);
    this.offsetRow = new Signal(0);
    this.editCallback = options.editCallback;
    this.deleteCallback = options.deleteCallback;
    this.newCallback = options.newCallback;
    this.archiveCallback = options.archiveCallback;
    this.thresholdCallback = options.thresholdCallback;
    this.toggleHiddenCallback = options.toggleHiddenCallback;
    this.toggleStateCallback = options.toggleStateCallback;
    this.recurrenceCallback = options.recurrenceCallback;
    this.dueCallback = options.dueCallback;

    if (this.lastSelectedId === undefined) {
      this.lastSelectedId = options.data.peek()[0]?.id;
    }

    // Keep track of last selected id so we can reselect it if it changes index
    this.selectedRow.subscribe((selectedRow) => {
      const index = this.indexes.peek()[selectedRow];

      if (index?.type === IndexType.context) {
        return;
      }
      this.lastSelectedId = this.data.peek()[index?.todoNumber ?? -1]?.id;
    });

    // Track size of todo number padding
    this.data.subscribe((data) => {
      const todoNumberPadding = data.length.toString().length;
      if (todoNumberPadding !== this.numberPadding.peek()) {
        this.numberPadding.value = todoNumberPadding;
      }
    });

    this.numberPadding = new Signal(
      options.data.peek().length.toString().length,
    );

    this.indexes.subscribe((indexes) => {
      // Draw extra objects if data was changed
      const dataDrawObjects = this.drawnRows.length;
      if (indexes.length > dataDrawObjects) {
        this.#fillDataDrawObjects();
      } else if (indexes.length < dataDrawObjects) {
        this.popUnusedDataDrawObjects();
      }
      // Reselect item if it changed index (eg -> change prio / state)
      const index = indexes[this.selectedRow.peek()];

      if (
        !index || index.type !== IndexType.todo ||
        this.data.peek()[index.todoNumber!]?.id !== this.lastSelectedId
      ) {
        const newIndexNr = indexes.findIndex((x) =>
          x.type === IndexType.todo &&
          this.data.peek()[x.todoNumber!]?.id === this.lastSelectedId
        );
        if (newIndexNr !== -1) {
          this.selectedRow.value = newIndexNr;
        } else {
          // File updated and id not present anymore
          this.lastSelectedId = index && index.type === IndexType.todo
            ? this.data.peek()[index.todoNumber!]?.id
            : undefined;
        }
      }
      this.clampOffsetRow();
    });

    this.rectangle.subscribe(debounce(
      () => {
        this.clampOffsetRow();

        // Redraw everything. Popping / adding selectively gave bugs
        let row = this.drawnRows.pop();
        while (row) {
          Object.keys(row!).forEach((k) => row![k].erase());
          row = this.drawnRows.pop();
        }
        this.#fillDataDrawObjects();
      },
      200,
    ));

    this.on("keyPress", async ({ key, ctrl, meta, shift }) => {
      const { selectedRow } = this;

      let newSelectedRow = selectedRow.value;

      const index = this.indexes.peek()[selectedRow.value];

      let currentSelectedTodo: Todo | null = null;

      if (index?.type === IndexType.todo) {
        currentSelectedTodo = this.data.peek()[index.todoNumber!];
      }

      if (
        currentSelectedTodo && shift &&
        ["A", "B", "C", "D", "E", "F"].includes(key)
      ) {
        currentSelectedTodo.setPriority(key as UpperCaseLetter);
      }

      if (ctrl || meta || shift) return;

      const lastDataRow = this.indexes.peek().length - 1;
      switch (key) {
        case "a":
          setTimeout(() => this.archiveCallback(), 0);
          return;
        case "q":
          Deno.exit(0);
          return;
        case "e":
          if (currentSelectedTodo) {
            setTimeout(() => this.editCallback(currentSelectedTodo), 0);
          }
          return;
        case "d": // Due
          if (currentSelectedTodo) {
            setTimeout(() => this.dueCallback(currentSelectedTodo), 0);
          }
          return;
        case "t": // Threshold
          if (currentSelectedTodo) {
            setTimeout(() => this.thresholdCallback(currentSelectedTodo), 0);
          }
          return;
        case "r": // Recurrence
          if (currentSelectedTodo) {
            setTimeout(() => this.recurrenceCallback(currentSelectedTodo), 0);
          }
          return;
        case "n":
          setTimeout(() => {
            this.newCallback().then((todo) => {
              if (todo !== undefined) {
                this.setSelectedTodo(todo);
              }
            });
          }, 0);
          return;
        case "space":
          if (currentSelectedTodo) {
            this.toggleStateCallback(currentSelectedTodo);
          }
          return;
        case "delete":
          if (currentSelectedTodo) {
            setTimeout(() => this.deleteCallback(currentSelectedTodo));
          }
          return;
        case "c":
          if (currentSelectedTodo) {
            await writeText(currentSelectedTodo.toString());
          }
          return;
        case "h":
          if (currentSelectedTodo) {
            setTimeout(() => this.toggleHiddenCallback(currentSelectedTodo));
          }
          return;
        case "up":
          --newSelectedRow;
          break;
        case "down":
          ++newSelectedRow;
          break;
        case "pageup":
          newSelectedRow -= 5;
          break;
        case "pagedown":
          newSelectedRow += 5;
          break;
        case "home":
          newSelectedRow = 1;
          break;
        case "end":
          newSelectedRow = lastDataRow;
          break;
      }

      if (newSelectedRow === selectedRow.value) {
        return;
      }

      const newIndex = this.indexes.peek()[newSelectedRow];

      if (
        newIndex?.type === IndexType.context &&
        ["pagedown", "down"].includes(key)
      ) {
        newSelectedRow++;
      }
      if (
        newIndex?.type === IndexType.context && ["pageup", "up"].includes(key)
      ) {
        newSelectedRow--;
      }

      selectedRow.value = clamp(newSelectedRow, 1, lastDataRow);

      this.clampOffsetRow();
    });

    this.on("mouseEvent", (mouseEvent) => {
      if (mouseEvent.ctrl || mouseEvent.meta || mouseEvent.shift) return;
      const { y } = mouseEvent;
      const { row, height } = this.rectangle.peek();

      const lastDataRow = this.indexes.peek().length - 1;

      if ("scroll" in mouseEvent) {
        this.offsetRow.value = clamp(
          this.offsetRow.peek() + mouseEvent.scroll,
          0,
          lastDataRow - height + 1,
        );
      } else if ("button" in mouseEvent && y >= row && y <= row + height - 1) {
        const dataRow = y - row + this.offsetRow.peek();
        if (
          dataRow === clamp(dataRow, 0, lastDataRow) &&
          this.selectedRow.value !== dataRow
        ) {
          this.selectedRow.value = dataRow;
        }
      }
    });
  }

  private clampOffsetRow() {
    this.offsetRow.value = clamp(
      clamp(
        this.offsetRow.value,
        this.selectedRow.value - (this.rectangle.value.height - 2),
        this.selectedRow.value - 1,
      ),
      0,
      this.indexes.value.length - this.rectangle.value.height,
    );
  }

  override draw(): void {
    super.draw();

    // Drawing data cells
    this.#fillDataDrawObjects();
  }

  #fillDataDrawObjects(): void {
    const { canvas } = this.tui;
    const { drawnRows } = this;
    const nrOfToDrawRows = clamp(
      this.indexes.peek().length,
      0,
      this.rectangle.peek().height,
    );

    for (let i = drawnRows.length; i < nrOfToDrawRows; i++) {
      const contextText = new TextObject({
        canvas,
        view: this.view,
        zIndex: this.zIndex.value + 2,
        style: crayon.bgYellow.black,
        value: new Computed(() => {
          const index = this.indexes.value[i + this.offsetRow.value];

          if (index?.type !== IndexType.context) {
            return "";
          }

          return ` ${index.contextName} (${index.todoCount}) `;
        }),
        rectangle: new Computed(() => {
          const { column, row } = this.rectangle.value;

          return {
            column: column,
            row: row + i,
          };
        }),
      });

      const box = new BoxObject({
        canvas,
        view: this.view,
        zIndex: this.zIndex.value,
        style: this.getRowStyle(i),

        rectangle: new Computed(() => {
          const { column, row, width } = this.rectangle.value;

          return {
            height: 1,
            column: column,
            row: row + i,
            width: width,
          };
        }),
      });

      const number = new TextObject({
        canvas,
        view: this.view,
        zIndex: this.zIndex.value + 1,
        style: new Computed(() => {
          const offsetRow = this.offsetRow.value;
          const selectedRow = this.selectedRow.value;
          const index = this.indexes?.value[i + offsetRow];

          if (index?.type !== IndexType.todo) {
            return crayon;
          }
          const todo = this.data.value[index.todoNumber!];
          let [selected, base] = this.getTodoStyles(todo);
          base = base.dim;
          selected = selected.dim;

          return (i + offsetRow) === selectedRow ? selected : base as Style;
        }),
        value: new Computed(() => {
          const index = this.indexes?.value[i + this.offsetRow.value];
          const counterRowWidth = this.data.value.length.toString().length;

          if (index?.type !== IndexType.todo) {
            return "";
          }

          return (index.todoNumber! + 1)
            .toString()
            .padStart(counterRowWidth);
        }),
        rectangle: new Computed(() => {
          const { column, row } = this.rectangle.value;

          return {
            column: column + 1,
            row: row + i,
          };
        }),
      });

      const check = new TextObject({
        canvas,
        view: this.view,
        zIndex: this.zIndex.value + 1,
        style: this.getRowStyle(i),
        value: new Computed(() => {
          const index = this.indexes?.value[i + this.offsetRow.value];

          if (index?.type !== IndexType.todo) {
            return "";
          }
          const todo = this.data.value[index.todoNumber!];
          if (!todo) {
            return "";
          }
          const text: string = todo.isDone() ? "[x]" : "[ ]";
          return text;
        }),
        rectangle: new Computed(() => {
          const { column, row } = this.rectangle.value;

          return {
            column: column + 2 + this.numberPadding.value,
            row: row + i,
          };
        }),
      });

      const priority = new TextObject({
        canvas,
        view: this.view,
        zIndex: this.zIndex.value + 2,
        style: new Computed(() => {
          const offsetRow = this.offsetRow.value;
          const selectedRow = this.selectedRow.value;

          const index = this.indexes?.value[i + offsetRow];

          if (index?.type !== IndexType.todo) {
            return crayon.bgBlack as Style;
          }
          const todo = this.data.value[index.todoNumber!];

          let [selected, base] = this.getTodoStyles(todo);
          switch (todo?.priority) {
            case "A":
              selected = selected.lightCyan;
              base = base.lightCyan;
              break;
            case "B":
              selected = selected.lightMagenta;
              base = base.lightMagenta;
              break;
            case "C":
              selected = selected.lightYellow;
              base = base.lightYellow;
              break;
            case "D":
              selected = selected.lightBlue;
              base = base.lightBlue;
              break;
            case "E":
              selected = selected.lightGreen;
              base = base.lightGreen;
              break;
            case "F":
              selected = selected.lightRed;
              base = base.lightRed;
              break;
            default:
              selected = selected.dim;
              base = base.white;
          }

          return (i + offsetRow) === selectedRow
            ? selected as Style
            : base as Style;
        }),
        value: new Computed(() => {
          const index = this.indexes?.value[i + this.offsetRow.value];

          if (index?.type !== IndexType.todo) {
            return "";
          }
          const dataRow = this.data.value[index.todoNumber!];

          if (!dataRow?.priority) {
            return "";
          }

          return ` (${dataRow.priority})`;
        }),
        rectangle: new Computed(() => {
          const { column, row } = this.rectangle.value;

          return {
            column: column + this.numberPadding.value + 5,
            row: row + i,
          };
        }),
      });

      const main = new TextObject({
        multiCodePointSupport: true,
        canvas,
        view: this.view,
        zIndex: this.zIndex.value + 1,
        style: this.getRowStyle(i),
        value: new Computed(() => {
          const index = this.indexes?.value[i + this.offsetRow.value];

          if (index?.type !== IndexType.todo) {
            return "";
          }
          const todo = this.data.peek()[index.todoNumber!];
          if (!todo) {
            return "";
          }
          const tagsText = Object.keys(todo.tags).map((x) =>
            `${x}:${todo.tags[x]}`
          ).join(" ");

          return `${todo.text} ${tagsText} (${i})`;
        }),
        rectangle: new Computed(() => {
          const { column, row } = this.rectangle.value;
          const index = this.indexes?.value[i + this.offsetRow.value];

          if (index?.type !== IndexType.todo) {
            return {
              column: column + 1 + this.numberPadding.value + 5,
              row: row + i,
            };
          }

          const todo = this.data.peek()[index.todoNumber!];

          return {
            column: column + 1 + this.numberPadding.value +
              (todo?.priority ? 9 : 5),
            row: row + i,
          };
        }),
      });

      const drawnRow = { priority, box, main, number, contextText, check };

      drawnRows.push(drawnRow);
      contextText.draw();
      number.draw();
      check.draw();
      priority.draw();
      box.draw();
      main.draw();
    }
    /* Debug code
    const index = new TextObject({
      canvas,
      view: this.view,
      zIndex: 120,
      style: this.getRowStyle(0),
      value: new Computed(() => {
        return "SELECTED: " + this.selectedRow.value.toString() + " DRAWN ROWS: " + drawnRows.length + " INDEXES-LENGHT: " + this.indexes.value.length + " AMOUNT PAINTED: " + this.iTracker.value;
      }),
      rectangle: new Computed(() => {
        return {
          column: 25,
          row: 0,
        };
      }),
    });
    index.draw()
    */
  }
  private getRowStyle = (i: number): Signal<Style> =>
    new Computed(() => {
      const offsetRow = this.offsetRow.value;
      const selectedRow = this.selectedRow.value;
      const index = this.indexes.value[i + offsetRow];
      if (index?.type !== IndexType.todo) {
        return crayon.bgBlack;
      }
      const todo = this.data.value[index.todoNumber!];
      const [selected, base] = this.getTodoStyles(todo);

      return (i + offsetRow) === selectedRow ? selected : base as Style;
    });
  private getTodoStyles(todo: Todo): [typeof crayon, typeof crayon] {
    let selected = crayon.bgWhite.black;
    let base = crayon.bgBlack.white;

    if (todo?.isOverdue() && !todo?.isDone()) {
      base = crayon.bgBlack.lightRed;
      selected = crayon.bgLightRed.black;
    }
    return [selected, base];
  }

  private popUnusedDataDrawObjects(): void {
    while (
      this.drawnRows.length >
        clamp(this.indexes.peek().length, 0, this.rectangle.peek().height)
    ) {
      const row = this.drawnRows.pop();
      Object.keys(row!).forEach((k) => row![k].erase());
    }
  }

  public getSelectedTodo(): Todo | undefined {
    const index = this.indexes.value[this.selectedRow.value];

    if (index.type !== IndexType.todo) {
      return;
    }

    return this.data.value[index.todoNumber];
  }

  public setSelectedTodo(todo: { id: symbol }): void {
    const i = this.data.peek().findIndex((x) => x.id === todo.id);
    if (i) {
      this.selectedRow.value = this.indexes.value.findIndex((x) =>
        x.type === IndexType.todo && x.todoNumber === i
      );
      this.clampOffsetRow();
    }
  }
}
