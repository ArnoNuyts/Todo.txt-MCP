import { Crayon, crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import {
  Component,
  Computed,
  Signal,
  Style,
  TextObject
} from "https://deno.land/x/tui@2.1.11/mod.ts";

export interface TodoActionMenuItemOptions {
  parent: Component;
  zIndex: Signal<number>;
  row: Computed<number>;
  key: string;
  description: string;
  callBack: () => void;
  isSelected: Signal<boolean>;
}

export class TodoActionMenuItem extends Component {
  key: string;
  description: string;
  callBack: () => void;
  baseStyle: Signal<Crayon>;

  constructor(options: TodoActionMenuItemOptions) {
    const rectangle = new Computed(() => (
       {
        column: options.parent.rectangle.value.column + 1,
        height: 1,
        row: options.row.value,
        width: options.parent.rectangle.value.width,
      }));

    super(
      {
        parent: options.parent,
        zIndex: options.zIndex,
        rectangle,
        theme: {}
      },
    );
    this.key = options.key;
    this.description = options.description;
    this.callBack = options.callBack;
    this.baseStyle = new Computed(() => options.isSelected.value ? crayon.bgWhite: crayon.bgBlack);
    this.style = this.baseStyle as unknown as Signal<Style>;
  }

  override draw(): void {

    super.draw();

    const { canvas } = this.tui;



    const key = new TextObject({
      canvas,
      view: this.view,
      zIndex: this.zIndex.value + 1,
      style: new Computed(() => crayon.bgBlack.lightYellow as Style),
      value: this.key.padStart(5, " "),
      rectangle: new Computed(() => {
        const { column, row } = this.rectangle.value;

        return {
          column: column,
          row: row,
        };
      }),
    });

    const description = new TextObject({
      canvas,
      view: this.view,
      zIndex: this.zIndex.value + 1,
      style: new Computed(() => this.baseStyle.value.lightCyan as Style),
      value: new Computed(() => " " + this.description.padEnd(this.rectangle.value.width - (this.key.length < 5 ? 5 : this.key.length) -4, " ")),
      rectangle: new Computed(() => {
        const { column, row } = this.rectangle.value;

        return {
          column: column + (this.key.length < 5 ? 5 : this.key.length) +1,
          row: row,
        };
      }),
    });

    key.draw();
    description.draw();
    this.drawnObjects.key = key;
    this.drawnObjects.description = description;
  }
}

