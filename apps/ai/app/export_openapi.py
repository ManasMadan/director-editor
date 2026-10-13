"""Write the service's OpenAPI schema to a file, without starting a server.

Run as `python -m app.export_openapi <file>` via `bun run gen` (turbo), which then
regenerates packages/ai-client.
CI fails if the committed schema is out of date, so the TypeScript types can never
drift from the Python models.
"""

import json
import sys
from pathlib import Path

from app.main import app

out = Path(sys.argv[1] if len(sys.argv) > 1 else "openapi.json")
out.write_text(json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n")
sys.stdout.write(f"Wrote {out}\n")
