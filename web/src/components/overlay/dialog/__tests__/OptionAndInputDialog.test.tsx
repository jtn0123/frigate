import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import OptionAndInputDialog from "../OptionAndInputDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it("associates new-option fields with labels and saves their edited values", async () => {
  const onCreateNew = vi.fn().mockResolvedValue(undefined);
  const setOpen = vi.fn();
  render(
    <OptionAndInputDialog
      open
      title="Create option"
      description="Option details"
      options={[{ value: "new", label: "New option" }]}
      newValueKey="new"
      nameLabel="Option name"
      descriptionLabel="Option description"
      setOpen={setOpen}
      onSave={vi.fn()}
      onCreateNew={onCreateNew}
    />,
  );
  const name = screen.getByLabelText("Option name");
  const description = screen.getByLabelText("Option description");
  expect(name.id).not.toBe(description.id);
  fireEvent.change(name, { target: { value: "  Front camera  " } });
  fireEvent.change(description, { target: { value: "  Visitor footage  " } });
  fireEvent.click(screen.getByRole("button", { name: "button.save" }));
  await waitFor(() =>
    expect(onCreateNew).toHaveBeenCalledWith("Front camera", "Visitor footage"),
  );
  expect(setOpen).toHaveBeenCalledWith(false);
});
