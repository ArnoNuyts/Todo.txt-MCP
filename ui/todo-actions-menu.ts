import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import { clamp, Computed, Tui, Signal } from "https://deno.land/x/tui@2.1.11/mod.ts";
import { Box } from "https://deno.land/x/tui@2.1.11/src/components/box.ts";
import { Frame } from "https://deno.land/x/tui@2.1.11/src/components/frame.ts";
import { TodoActionMenuItem } from "./todo-action-menu-item.ts";
import { keepComponentFocussed } from "./tui-helpers.ts";

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
  },
): Promise<string> => {
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
        row: Math.floor((parent.rectangle.value.height - 10) / 2),
        height: 7,
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

  const actions = [
    { name: "Edit", shortcut: "e", callBack: callbacks.edit },
    { name: "Delete", shortcut: "del", callBack: callbacks.delete },
    { name: "Toggle Complete", shortcut: "space", callBack: callbacks.toggleComplete },
    { name: "Set Due Date", shortcut: "d", callBack: callbacks.setDueDate },
    { name: "Set Threshold Date", shortcut: "t", callBack: callbacks.setThresholdDate },
    { name: "Set Recurrence", shortcut: "r", callBack: callbacks.setRecurrence },
    { name: "Toggle Hidden", shortcut: "h", callBack: callbacks.toggleHidden },
  ];


  const selectedRow = new Signal(0);

  const menuItems: TodoActionMenuItem[] = actions.map((action, index) => 
    new TodoActionMenuItem({
      parent: box,
      zIndex: new Signal(6),
      row: new Computed(() => frame.rectangle.value.row + index),
      key: action.shortcut,
      description: action.name,
      callBack: action.callBack,
      isSelected: new Computed(() => index == selectedRow.value),
    })
  );
  box.draw();
  frame.draw();

  menuItems.forEach((item) => item.draw());

  keepComponentFocussed(box);

  return new Promise((resolve, reject) => {
    box.on("keyPress", ({ key }) => {
      if (key === "escape") {
        menuItems.forEach(x => x.destroy()); 
        box.destroy();
        reject("Canceled");
      } else if (key === "up") {
        selectedRow.value = Math.max(0, selectedRow.value - 1);
      } else if (key === "down") {
        selectedRow.value = Math.min(actions.length - 1, selectedRow.value + 1);
      } else if (key === "return") {
        menuItems.forEach(x => x.destroy()); 
        box.destroy();
        // Should this be awaited?
        setTimeout(menuItems[selectedRow.value].callBack,0);
        resolve(actions[selectedRow.value].name);
      }
    });
  });
};
