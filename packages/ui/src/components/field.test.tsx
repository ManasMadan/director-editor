import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "../../test/render";
import { Checkbox } from "./checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
  FieldTitle,
} from "./field";

describe("Field", () => {
  it("lays out a title and description next to a control, and separates fields", async () => {
    render(
      <FieldGroup>
        <Field orientation="horizontal">
          <Checkbox id="digest" aria-label="Daily digest" />
          <FieldContent>
            <FieldTitle>Daily digest</FieldTitle>
            <FieldDescription>One email a day instead of one each time.</FieldDescription>
          </FieldContent>
        </Field>
        <FieldSeparator />
        <FieldSeparator>or</FieldSeparator>
        <Field>
          <FieldLabel htmlFor="other">Other</FieldLabel>
        </Field>
      </FieldGroup>,
    );
    await expect.element(page.getByText("Daily digest", { exact: true })).toBeVisible();
    await expect.element(page.getByText("or", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("separator").first()).toBeInTheDocument();
  });
});

describe("FieldError", () => {
  it("shows its children as they are", async () => {
    render(<FieldError>Pick a date in the future</FieldError>);
    await expect.element(page.getByRole("alert")).toHaveTextContent("Pick a date in the future");
  });

  it("shows nothing without errors", async () => {
    render(
      <>
        <p>Email</p>
        <FieldError />
        <FieldError errors={[]} />
      </>,
    );
    await expect.element(page.getByText("Email")).toBeVisible();
    expect(page.getByRole("alert").elements()).toHaveLength(0);
  });

  it("lists several errors once each, skipping any without a message", async () => {
    render(
      <FieldError
        errors={[
          { message: "Too short" },
          undefined,
          { message: "Too short" },
          { message: "No digits" },
        ]}
      />,
    );
    const items = page.getByRole("alert").getByRole("listitem");
    await expect.element(items.first()).toHaveTextContent("Too short");
    expect(items.elements().map((item) => item.textContent)).toEqual(["Too short", "No digits"]);
  });
});
