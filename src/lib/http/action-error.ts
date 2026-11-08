import { isRedirectError } from "next/dist/client/components/redirect-error";
import { errorMessage } from "@/lib/board/text";

export function actionError(error: unknown): string {
  if (isRedirectError(error)) throw error;
  return errorMessage(error);
}
