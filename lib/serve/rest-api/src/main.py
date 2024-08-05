#   Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
#   Licensed under the Apache License, Version 2.0 (the "License").
#   You may not use this file except in compliance with the License.
#   You may obtain a copy of the License at
#
#       http://www.apache.org/licenses/LICENSE-2.0
#
#   Unless required by applicable law or agreed to in writing, software
#   distributed under the License is distributed on an "AS IS" BASIS,
#   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#   See the License for the specific language governing permissions and
#   limitations under the License.

"""REST API."""
import os
import sys
import time
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from loguru import logger

from .api.routes import router

logger.remove()
logger_level = os.environ.get("LOG_LEVEL", "INFO")
logger.configure(
    extra={
        "request_id": "NO_REQUEST_ID",
        "endpoint": "NO_ENDPOINT",
        "event": "NO_EVENT",
        "status": "NO_STATUS",
    },
    handlers=[
        {
            "sink": sys.stdout,
            "format": (
                "<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <cyan>{extra[request_id]}</cyan> | "
                "<level>{level: <8}</level> | <yellow>{extra[endpoint]}</yellow> | "
                "<blue>{extra[event]}</blue> | <magenta>{extra[status]}</magenta> | {message}"
            ),
            "level": logger_level.upper(),
        }
    ],
)

app = FastAPI()
app.include_router(router)


# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


##############
# MIDDLEWARE #
##############


@app.middleware("http")  # type: ignore
async def process_request(request: Request, call_next: Any) -> Any:
    """Middleware for processing all HTTP requests."""
    event = "process_request"
    request_id = str(uuid4())  # Unique ID for this request
    tic = time.time()

    with logger.contextualize(request_id=request_id, endpoint=request.url.path):
        try:
            task_logger = logger.bind(event=event)
            task_logger.debug("Start task", status="START")

            # Attempt to call the next request handler
            response = await call_next(request)

            # If response is successful, log the finish status
            duration = time.time() - tic
            task_logger.debug(f"Finish task (took {duration:.2f} seconds)", status="FINISH")

        except Exception as e:
            # In case of an exception, log the error and prepare a generic response
            duration = time.time() - tic
            task_logger.exception(
                f"Error occurred during processing: {e} (took {duration:.2f} seconds)",
                status="ERROR",
            )
            response = JSONResponse(
                status_code=500,
                content={"detail": "Internal server error"},
            )

        # Add the unique request ID to the response headers
        if response is not None and isinstance(response, Response):
            response.headers["X-Request-ID"] = request_id

    return response
