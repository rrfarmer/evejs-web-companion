"""Exercise the bootstrap's archive loader with the host Python and a temporary zip."""
import importlib.util
from pathlib import Path
import py_compile
import sys
import tempfile
import unittest
from zipfile import ZipFile


BOOTSTRAP = Path(__file__).resolve().parents[2] / "scripts/native-prefs/bootstrap.py"


class ArchiveTest(unittest.TestCase):
    def open_archive(self, modules):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        archive = root / "code.ccp"
        with ZipFile(archive, "w") as zip_file:
            for name, filename, source in modules:
                script, compiled = root / "module.py", root / "module.pyc"
                script.write_text(source, encoding="utf8")
                py_compile.compile(str(script), str(compiled), dfile=filename, doraise=True)
                zip_file.write(compiled, name + "/__init__.pyc")

        # Run the real bootstrap up to its first native binding. Its Python 2
        # finder uses the same zipimporter/get_code interface under Python 3.
        setup, boundary, _ = BOOTSTRAP.read_text(encoding="utf8").partition("\nimport _client_prefs_io\n")
        self.assertTrue(boundary)
        self.addCleanup(setattr, sys, "path", sys.path.copy())
        self.addCleanup(setattr, sys, "meta_path", sys.meta_path.copy())
        for name in ("future.utils", "future"):
            self.addCleanup(sys.modules.pop, name, None)
        namespace = {"_CLIENT_MODULES_RAW": archive.as_posix().encode("utf8")}
        exec(compile(setup, str(BOOTSTRAP), "exec"), namespace)
        finder = sys.meta_path[0]

        class Python3Finder:
            def find_spec(self, name, path=None, target=None):
                loader = finder.find_module(name, path)
                return importlib.util.spec_from_loader(name, loader) if loader else None

        sys.meta_path[0] = Python3Finder()
        return namespace["_core_service_globals"]

    def test_archived_packages(self):
        service_globals = self.open_archive([
            ("future", "/client/packages/future/__init__.py", ""),
            ("future/utils", "/client/packages/future/utils/__init__.py", "from sys import exit as raise_"),
        ])
        namespace = service_globals(None, None, None, 0)
        import future.utils
        self.assertIs(namespace["raise_"], future.utils.raise_)
        self.assertIn("code.ccp", future.__file__)
        self.assertIn("code.ccp", future.utils.__file__)
        exec("def InitService():\n    return lambda: raise_(42)", namespace)
        with self.assertRaises(SystemExit) as raised:
            namespace["InitService"]()()
        self.assertEqual(raised.exception.code, 42)

    def test_missing_package(self):
        service_globals = self.open_archive([])
        self.assertNotIn("raise_", service_globals(None, None, None, 0))

    def test_wrong_code_path(self):
        service_globals = self.open_archive([
            ("future", "/client/packages/future/__init__.py", ""),
            ("future/utils", "/client/packages/future/utils.py", ""),
        ])
        with self.assertRaisesRegex(ImportError, "Not an installed preference/stdlib module"):
            service_globals(None, None, None, 0)


if __name__ == "__main__":
    unittest.main()
