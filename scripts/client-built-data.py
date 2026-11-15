"""Read one of the retail client's built data files with the client's own loader.

Much of the client's static data is "cFSD": a binary file (res:/staticdata/
<name>.fsdbinary) laid out by a schema that is compiled into a loader module
beside the client's executable (bin64/<name>Loader.pyd). Only that loader knows
the layout. This runs the loader inside the client's own python27.dll, walks
what it returns, and prints it as one JSON document.

    python scripts/client-built-data.py <client bin64 folder> <loader module> <data file> [<attribute>] [keys=<k,k>]

    <loader module>  the loader's module name, "missionsLoader"
    <data file>      the .fsdbinary on disk (under the client's ResFiles)
    <attribute>      where given, only that attribute of each of the table's rows, by the row's key; rows without it
                     are left out ("isisGroupID" of the types: a table too big to walk whole)
    keys=<k,k>       where given, only the rows of those keys (whole numbers), each looked up by itself as the
                     client's own data module does (dogma/data.py get_type_dogma: the table's .get(typeID)); a key the
                     table has not is left out. For a table too big to walk whole whose rows are wanted whole
                     ("typeDogma": a type's dogma attributes)

What is printed: a cfsd dict as an object (its keys as strings), a cfsd list or
vector as an array, a cfsd object as an object of the attributes it has (an
optional attribute it does not have is left out), and numbers, strings, true,
false and null as themselves.

Nothing of the client is copied into this repository: its loader and its data
are read where they are, when this is run. Run it with a 64-bit Python 3 on
Windows. See scripts/py27-oracle.py for how the second Python is loaded.
"""

import ctypes
import os
import re
import sys
import tempfile

# Python 2.7 source, run inside the client's interpreter. Only its builtin modules are there: no json and no
# codecs, so the JSON is written by hand.
WALKER = r'''
def text(value):
    if isinstance(value, str):
        try:
            value = unicode(value, 'utf-8')
        except Exception:
            value = unicode(value, 'latin-1')
    parts = ['"']
    for char in value:
        number = ord(char)
        if number == 34:
            parts.append('\\"')
        elif number == 92:
            parts.append('\\\\')
        elif 32 <= number < 127:
            parts.append(chr(number))
        else:
            parts.append('\\u%04x' % number)
    parts.append('"')
    return ''.join(parts)

def walk(value, depth):
    if depth > 40:
        raise RuntimeError('The data is nested deeper than this walks.')
    if value is None:
        return 'null'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, (int, long)):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float('inf'), float('-inf')):
            return 'null'
        return repr(value)
    if isinstance(value, basestring):
        return text(value)
    if hasattr(value, 'iteritems'):
        return '{' + ','.join([text(str(key)) + ':' + walk(item, depth + 1) for key, item in value.iteritems()]) + '}'
    if isinstance(value, (list, tuple)) or hasattr(value, '__iter__') or hasattr(value, '__getitem__') and hasattr(value, '__len__'):
        return '[' + ','.join([walk(item, depth + 1) for item in value]) + ']'
    parts = []
    names = dir(value)
    if LOADER == 'dogmaAttributesLoader' and hasattr(value, 'attributeID'):
        # The installed cFSD accessor returns None for these optional fields
        # even when dir() omits them. Native factory/cap selection reads them
        # directly. Preserve the ACTUAL getter value, not a fabricated False.
        # cdxdefinitionaccessagent1: all2855 rows, zero direct getter failures.
        names = sorted(set(names) | set(('chargeRechargeTimeID', 'maxAttributeID', 'minAttributeID')))
    for name in names:
        if name.startswith('_'):
            continue
        try:
            item = getattr(value, name)
        except AttributeError:
            continue
        if callable(item):
            continue
        parts.append(text(name) + ':' + walk(item, depth + 1))
    return '{' + ','.join(parts) + '}'
'''

# The run itself. BIN, LOADER, DATA and OUT are put in front of it. The only place modules are looked for is the
# client's own folder: the host Python's library must never be imported into this interpreter by accident.
LOAD = r'''
import sys
sys.path[:] = [BIN]
loader = __import__(LOADER)
__data = loader.load(DATA)
__out = open(OUT, 'wb')
if KEYS:
    __parts = []
    for __key in KEYS:
        __row = __data.get(__key)
        if __row is not None:
            __item = getattr(__row, ATTRIBUTE, None) if ATTRIBUTE else __row
            if __item is not None:
                __parts.append(text(str(__key)) + ':' + walk(__item, 1))
    __out.write('{' + ','.join(__parts) + '}')
elif ATTRIBUTE:
    __parts = []
    for __key, __row in __data.iteritems():
        if LOADER == 'typeDogmaLoader' and ATTRIBUTE == 'chargeGroups':
            # InfoSvc._AddUsedWithTypeIDs only reads chargeGroup1 through chargeGroup4.
            __item = [int(attr.value) for attr in (getattr(__row, 'dogmaAttributes', None) or [])
                      if attr.attributeID in (604, 605, 606, 609) and attr.value > 0]
            if not __item:
                continue
        else:
            __item = getattr(__row, ATTRIBUTE, None)
        if __item is not None:
            __parts.append(text(str(__key)) + ':' + walk(__item, 1))
    __out.write('{' + ','.join(__parts) + '}')
else:
    __out.write(walk(__data, 0))
__out.close()
'''


def main():
    if len(sys.argv) not in (4, 5, 6):
        sys.exit(__doc__)
    dll_dir, loader, data_file = sys.argv[1], sys.argv[2], sys.argv[3]
    rest = sys.argv[4:]
    keys_given = [part for part in rest if part.startswith("keys=")]
    attributes_given = [part for part in rest if not part.startswith("keys=")]
    if len(keys_given) > 1 or len(attributes_given) > 1:
        sys.exit(__doc__)
    attribute = attributes_given[0] if attributes_given else ""
    keys = []
    if keys_given:
        for part in keys_given[0][len("keys="):].split(","):
            if not re.match(r"^\d{1,12}$", part):
                sys.exit("A key is not a whole number: %r" % part)
            keys.append(int(part))
    if not re.match(r"^[A-Za-z0-9_]+Loader$", loader):
        sys.exit("The loader module's name is not one: %r" % loader)
    if attribute and not re.match(r"^[A-Za-z][A-Za-z0-9_]*$", attribute):
        sys.exit("The attribute's name is not one: %r" % attribute)
    if not os.path.isfile(os.path.join(dll_dir, loader + ".pyd")):
        sys.exit("The client has no %s.pyd in %s." % (loader, dll_dir))
    if not os.path.isfile(data_file):
        sys.exit("There is no data file at %s." % data_file)

    os.add_dll_directory(dll_dir)
    py27 = ctypes.CDLL(os.path.join(dll_dir, "python27.dll"))
    for flag in ("Py_NoSiteFlag", "Py_IgnoreEnvironmentFlag", "Py_DontWriteBytecodeFlag"):
        ctypes.c_int.in_dll(py27, flag).value = 1
    py27.Py_InitializeEx(0)

    handle, out_path = tempfile.mkstemp(suffix=".json")
    os.close(handle)
    try:
        names = "BIN = %r\nLOADER = %r\nDATA = %r\nOUT = %r\nATTRIBUTE = %r\nKEYS = %r\n" % (
            dll_dir.replace("\\", "/"),
            loader,
            data_file.replace("\\", "/"),
            out_path.replace("\\", "/"),
            attribute,
            keys,
        )
        status = py27.PyRun_SimpleString((names + WALKER + LOAD).encode("latin1"))
        if status != 0:
            sys.exit("The loader raised inside Python 2.7 (its traceback went to stderr).")
        with open(out_path, "rb") as result:
            sys.stdout.buffer.write(result.read())
    finally:
        os.remove(out_path)


if __name__ == "__main__":
    main()
