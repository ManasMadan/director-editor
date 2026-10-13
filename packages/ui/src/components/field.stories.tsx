import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "./field";
import { Input } from "./input";

const meta = { component: Field } satisfies Meta<typeof Field>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithDescription: Story = {
  render: () => (
    <Field className="w-80">
      <FieldLabel htmlFor="slug">Workspace URL</FieldLabel>
      <Input id="slug" defaultValue="acme" aria-describedby="slug-help" />
      <FieldDescription id="slug-help">Lowercase letters, numbers and dashes.</FieldDescription>
    </Field>
  ),
};

export const Invalid: Story = {
  render: () => (
    <Field data-invalid className="w-80">
      <FieldLabel htmlFor="email">Email</FieldLabel>
      <Input id="email" aria-invalid defaultValue="ada@" />
      <FieldError errors={[{ message: "Enter a valid email address" }]} />
    </Field>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent("Enter a valid email address");
  },
};

export const Group: Story = {
  render: () => (
    <FieldSet className="w-80">
      <FieldLegend>Profile</FieldLegend>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="first">First name</FieldLabel>
          <Input id="first" />
        </Field>
        <Field>
          <FieldLabel htmlFor="last">Last name</FieldLabel>
          <Input id="last" />
        </Field>
      </FieldGroup>
    </FieldSet>
  ),
};
