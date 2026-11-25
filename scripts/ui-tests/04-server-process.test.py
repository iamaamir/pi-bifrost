from pathlib import Path
import runpy
import sys

sys.dont_write_bytecode = True

scripts = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(scripts))
runpy.run_path(str(scripts / "test-tui-server-process.py"), run_name="__main__")
