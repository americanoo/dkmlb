#!/bin/bash
# Double-click on a Mac to start the local stats server and open the site.
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is needed. Install it from https://www.python.org/downloads/ and run this again."
  read -r -p "Press Return to close."
  exit 1
fi
if [ ! -x server/.venv/bin/python ]; then
  echo "First run: setting up (takes a minute)..."
  python3 -m venv server/.venv || { read -r -p "Setup failed. Press Return to close."; exit 1; }
fi
server/.venv/bin/python -m pip install -q --disable-pip-version-check -r server/requirements.txt \
  || { read -r -p "Installing packages failed. Press Return to close."; exit 1; }
server/.venv/bin/python server/server.py --open "$@"
