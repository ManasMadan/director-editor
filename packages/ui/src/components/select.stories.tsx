import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen } from "storybook/test";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

const ROLES = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
];

const meta = {
  component: Select,
  args: { onValueChange: fn(), defaultValue: "member", items: ROLES },
  render: (args) => (
    <Select {...args}>
      <SelectTrigger aria-label="Role" className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((role) => (
          <SelectItem key={role.value} value={role.value}>
            {role.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  ),
} satisfies Meta<typeof Select>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas, userEvent, args }) => {
    const trigger = canvas.getByRole("combobox", { name: "Role" });
    await expect(trigger).toHaveTextContent("Member");
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("option", { name: "Admin" }));
    await expect(args.onValueChange).toHaveBeenCalledWith("admin", expect.anything());
    await expect(trigger).toHaveTextContent("Admin");
  },
};

export const Disabled: Story = { args: { disabled: true } };
