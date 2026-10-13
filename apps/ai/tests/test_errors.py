"""Error responses: the contract's shape (packages/contracts errorResponse), with the
catalog's status for every code, whatever raised them."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.exceptions import HTTPException

from app.contracts.error_response import ErrorCode, ErrorResponse
from app.errors import STATUS, AppError, install_error_handlers
from tests.test_contracts import literal_values

app = FastAPI()
install_error_handlers(app)


@app.get("/raises/{status}")
def raises(status: int) -> None:
    raise HTTPException(status)


@app.get("/app-error")
def app_error() -> None:
    raise AppError("DOCUMENT_NOT_FOUND", {"id": "d-1", "count": 2})


@app.get("/bug")
def bug() -> None:
    raise RuntimeError("a detail that must not leave the service")


client = TestClient(app, raise_server_exceptions=False)


def test_every_code_has_the_catalog_s_status() -> None:
    assert literal_values(ErrorCode) == set(STATUS)
    assert AppError("DOCUMENT_NOT_FOUND").status == 404
    assert AppError("AI_BUDGET_EXCEEDED").status == 429


def test_an_app_error_has_the_contract_s_shape() -> None:
    response = client.get("/app-error", headers={"x-request-id": "r-1"})
    assert response.status_code == 404
    assert response.json() == {
        "defined": True,
        "code": "DOCUMENT_NOT_FOUND",
        "status": 404,
        "message": "DOCUMENT_NOT_FOUND",
        "data": {"params": {"id": "d-1", "count": 2}, "requestId": "r-1"},
    }
    ErrorResponse.model_validate(response.json())


def test_a_status_without_its_own_code_answers_with_the_generic_code_s_status() -> None:
    # 405 isn't in the catalog: it must not come back as BAD_REQUEST with status 405.
    response = client.get("/raises/405")
    assert (response.status_code, response.json()["code"], response.json()["status"]) == (
        400,
        "BAD_REQUEST",
        400,
    )
    response = client.get("/raises/503")
    assert (response.status_code, response.json()["code"]) == (500, "INTERNAL")
    response = client.get("/raises/403")
    assert (response.status_code, response.json()["code"]) == (403, "FORBIDDEN")


def test_a_bug_is_internal_and_says_nothing_about_itself() -> None:
    response = client.get("/bug", headers={"x-request-id": "r-2"})
    assert response.status_code == 500
    assert response.json()["code"] == "INTERNAL"
    assert response.json()["data"] == {"params": {}, "requestId": "r-2"}
    assert "detail" not in response.text
