# tflint (bun run lint:tflint): the Terraform rules bundled with it, every one of them.
plugin "terraform" {
  enabled = true
  preset  = "all"
}
