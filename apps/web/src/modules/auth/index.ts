// The auth module's public surface: its pages.

// Shared with other modules' forms (settings asks for passwords and codes too).
export { useAuthErrorMessage } from "./hooks/use-auth-error";
export { useAuthSchemas } from "./hooks/use-schemas";
export { CaptchaPage } from "./pages/captcha";
export { ForgotPasswordPage } from "./pages/forgot-password";
export { ResetPasswordPage } from "./pages/reset-password";
export { SignInPage } from "./pages/sign-in";
export { SignUpPage } from "./pages/sign-up";
export { TwoFactorPage } from "./pages/two-factor";
export { VerifyEmailPage } from "./pages/verify-email";
