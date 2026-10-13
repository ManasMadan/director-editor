import { render, screen } from "@testing-library/react-native";
import { useForm } from "react-hook-form";
import { FormField } from "./form-field";

function Form() {
  // No default value: the field starts empty, not "undefined".
  const form = useForm<{ nickname?: string }>();
  return <FormField control={form.control} name="nickname" label="Nickname" />;
}

/** Two screens' fields with one name, as a pushed screen sits over the one below it. */
function Stacked() {
  const signIn = useForm<{ password?: string }>();
  const reset = useForm<{ password?: string }>();
  return (
    <>
      <FormField control={signIn.control} name="password" label="Password" />
      <FormField control={reset.control} name="password" label="New password" />
    </>
  );
}

describe("FormField", () => {
  it("shows an empty field for a value the form doesn't have yet", async () => {
    await render(<Form />);
    expect(screen.getByLabelText("Nickname")).toHaveDisplayValue("");
  });

  it("names each field by its own label, though another field has the same name", async () => {
    await render(<Stacked />);
    const ids = ["Password", "New password"].map(
      (label) => screen.getByLabelText(label).props["aria-labelledby"],
    );
    expect(new Set(ids).size).toBe(2);
    expect(screen.getByText("New password").props.nativeID).toBe(ids[1]);
  });
});
