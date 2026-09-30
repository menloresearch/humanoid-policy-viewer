from pathlib import Path
import json

_HERE = Path(__file__).parent

_ALLOWED_EXTENSIONS = [".xml", ".png", ".stl", ".obj"]

# asimov-1 is a git submodule; only its sim-model/ folder is a scene asset, so a
# full (non-sparse) checkout doesn't pull CAD and electrical files into the index.
_SUBMODULE_SUBDIRS = {"asimov-1": "sim-model"}

if __name__ == "__main__":
    files_to_download = []
    for path in _HERE.rglob("*"):
      rel = path.relative_to(_HERE)
      if rel.parts[0] in _SUBMODULE_SUBDIRS and rel.parts[1:2] != (_SUBMODULE_SUBDIRS[rel.parts[0]],):
         continue
      if path.is_file() and path.suffix.lower() in _ALLOWED_EXTENSIONS:
         files_to_download.append(str(rel))
    files_to_download.sort()

    index_path = _HERE / "files.json"
    with open(index_path, mode="w") as f:
        json.dump(files_to_download, f, indent=2)
