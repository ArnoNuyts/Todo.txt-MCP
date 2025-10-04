import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import {
  clamp,
  Computed,
  Signal,
  Tui,
} from "https://deno.land/x/tui@2.1.11/mod.ts";
import { Box } from "https://deno.land/x/tui@2.1.11/src/components/box.ts";
import { Frame } from "https://deno.land/x/tui@2.1.11/src/components/frame.ts";
import { TodoActionMenuItem } from "./todo-action-menu-item.ts";
import { keepComponentFocussed } from "./tui-helpers.ts";
import { TodoActionMenuTitleItem } from "./todo-action-menu-title-item.ts";

export default (
  parent: Tui,
  callbacks: {
    edit: () => void;
    delete: () => void;
    toggleComplete: () => void;
    setDueDate: () => void;
    setThresholdDate: () => void;
    setRecurrence: () => void;
    toggleHidden: () => void;
    archive: () => void;
  },
): Promise<string> => {
  const actions = [
    //{ name: "Select todo", },
    { name: "Edit", shortcut: "e", callBack: callbacks.edit },
    { name: "Delete", shortcut: "del", callBack: callbacks.delete },
    {
      name: "Toggle Complete",
      shortcut: "space",
      callBack: callbacks.toggleComplete,
    },
    { name: "Set Due Date", shortcut: "d", callBack: callbacks.setDueDate },
    {
      name: "Set Threshold Date",
      shortcut: "t",
      callBack: callbacks.setThresholdDate,
    },
    { name: "Set Recurrence", shortcut: "r", callBack: callbacks.setRecurrence },
    { name: "Toggle Hidden", shortcut: "h", callBack: callbacks.toggleHidden },
   /* { name: "General" },
    { name: "Archive completed todos", shortcut: "a", callBack: callbacks.archive },
    { name: "Quit", shortcut: "q", callBack: Deno.exit },*/

  ];

  const box = new Box({
    parent: parent,
    theme: {
      base: crayon.bgBlack.white,
    },
    rectangle: new Computed(() => {
      let width = clamp(
        clamp(parent.rectangle.value.width / 2, 20, 60),
        0,
        parent.rectangle.value.width,
      );
      if (width % 2 !== 0) {
        // Adjust the value to make it even
        width = Math.floor(width / 2) * 2; // Rounds down to nearest even number
      }

      return {
        column: Math.floor((parent.rectangle.value.width - width) / 2),
        row: Math.floor((parent.rectangle.value.height - actions.length) / 2),
        height: actions.length,
        width: width,
      };
    }),
    zIndex: 5,
  });

  const frame = new Frame({
    parent: box,
    charMap: "sharp",
    theme: {
      base: crayon.bgBlack.white,
    },
    rectangle: box.rectangle,
    zIndex: 5,
  });

  const selectedRow = new Signal(0);

  const menuItems: (TodoActionMenuItem | TodoActionMenuTitleItem)[] = actions
    .map((action, index) => {
      if (!action.callBack) {
        return new TodoActionMenuTitleItem({
          parent: box,
          zIndex: new Signal(6),
          row: new Computed(() => frame.rectangle.value.row + index),
          description: action.name,
        });
      }
      return new TodoActionMenuItem({
        parent: box,
        zIndex: new Signal(6),
        row: new Computed(() => frame.rectangle.value.row + index),
        key: action.shortcut as string,
        description: action.name,
        callBack: action.callBack as () => void,
        isSelected: new Computed(() => index == selectedRow.value),
      });
    });
  box.draw();
  frame.draw();

  menuItems.forEach((item) => item.draw());

  keepComponentFocussed(box);

  return new Promise((resolve, reject) => {
    box.on("keyPress", ({ key }) => {
      if (key === "escape") {
        menuItems.forEach((x) => x.destroy());
        box.destroy();
        reject("Canceled");
      } else if (key === "up") {
        let newIndex = selectedRow.value - 1;
        while (newIndex >= 0 && !actions[newIndex].callBack) {
          newIndex--;
        }
        if (newIndex >= 0) {
          selectedRow.value = newIndex;
        }
      } else if (key === "down") {
        let newIndex = selectedRow.value + 1;
        while (newIndex < actions.length && !actions[newIndex].callBack) {
          newIndex++;
        }
        if (newIndex < actions.length) {
          selectedRow.value = newIndex;
        }
      } else if (key === "return") {
        if (!actions[selectedRow.value].callBack) return;
        menuItems.forEach((x) => x.destroy());
        box.destroy();
        // Should this be awaited?
        setTimeout(
          (menuItems[selectedRow.value] as TodoActionMenuItem).callBack,
          0,
        );
        resolve(actions[selectedRow.value].name);
      }
    });
  });
};
