"""Errors in the shape apps/api's own errors have on the wire (oRPC's error JSON, the
`errorResponse` schema in packages/contracts):

    {"defined": true, "code": "DOCUMENT_NOT_FOUND", "status": 404, "message": "DOCUMENT_NOT_FOUND",
     "data": {"params": {}, "requestId": "…", "issues": [...]}}

The model, the codes and their statuses are generated from packages/contracts
(app/contracts), so a code that isn't in the catalog doesn't type-check, and a status
can't disagree with the catalog's. apps/api passes codes on to clients, which translate
them. Raise `AppError("CODE", params)`; anything else becomes INTERNAL (details logged,
never returned).
"""

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import TypedDict

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import TypeAdapter
from starlette.exceptions import HTTPException

from app.contracts.error_response import ErrorCode, ErrorData, ErrorIssue, ErrorResponse
from app.log import log

STATUS = TypeAdapter(dict[ErrorCode, int]).validate_json(
    (Path(__file__).parent / "contracts" / "error_codes.json").read_bytes()
)
# Statuses the framework itself answers with (unknown route, wrong method, …).
_BY_STATUS: dict[int, ErrorCode] = {401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND"}

type Params = Mapping[str, str | int]


class _Problem(TypedDict):
    """The parts of a pydantic error this service reports (FastAPI hands them over untyped)."""

    loc: tuple[str | int, ...]
    type: str


_PROBLEMS = TypeAdapter(list[_Problem])


class AppError(Exception):
    def __init__(
        self, code: ErrorCode, params: Params | None = None, issues: Sequence[ErrorIssue] = ()
    ) -> None:
        super().__init__(code)
        self.code: ErrorCode = code
        self.status = STATUS[code]
        self.params = dict(params or {})
        self.issues = list(issues)


def error_response(error: AppError, request_id: str | None) -> JSONResponse:
    body = ErrorResponse(
        defined=True,
        code=error.code,
        status=error.status,
        message=error.code,
        data=ErrorData(
            params={**error.params},
            requestId=request_id,
            issues=error.issues or None,
        ),
    )
    return JSONResponse(body.model_dump(mode="json", exclude_none=True), status_code=error.status)


def install_error_handlers(app: FastAPI) -> None:
    def respond(request: Request, error: AppError) -> JSONResponse:
        return error_response(error, request.headers.get("x-request-id"))

    @app.exception_handler(AppError)
    async def app_error(request: Request, error: AppError) -> JSONResponse:
        return respond(request, error)

    @app.exception_handler(RequestValidationError)
    async def validation(request: Request, error: RequestValidationError) -> JSONResponse:
        issues = [
            # The first part says where the value was (body, query, …); the client
            # needs the field.
            ErrorIssue(path=list(problem["loc"][1:]), code=problem["type"])
            for problem in _PROBLEMS.validate_python(error.errors())
        ]
        return respond(request, AppError("VALIDATION_FAILED", issues=issues))

    @app.exception_handler(HTTPException)
    async def http(request: Request, error: HTTPException) -> JSONResponse:
        # A status without a code of its own answers as the catalog's generic code,
        # with that code's status, so the two never disagree.
        fallback: ErrorCode = "INTERNAL" if error.status_code >= 500 else "BAD_REQUEST"
        return respond(request, AppError(_BY_STATUS.get(error.status_code, fallback)))

    @app.exception_handler(Exception)
    async def unexpected(request: Request, error: Exception) -> JSONResponse:
        log.exception("unhandled error", path=request.url.path, error=str(error))
        return respond(request, AppError("INTERNAL"))
