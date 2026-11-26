# Python2 source executed in the installed python27.dll, not the host Python3.
# All preference methods/classes and stdlib dependencies below are the ORIGINAL
# code objects captured from this user's code.ccp. No parser is reconstructed.
import sys, zipimport, _codecs

sys.path[:] = []
_archive = _codecs.utf_8_decode(_CLIENT_MODULES_RAW)[0]


class InstalledPreferencesModules(object):

    def find_module(self, name, path=None):
        prefix = name.rpartition('.')[0].replace('.', '/')
        try:
            importer = zipimport.zipimporter(_archive + ('/' + prefix if prefix else ''))
            code = importer.get_code(name)
        except zipimport.ZipImportError:
            return None
        if code is None:
            raise ImportError('Not an installed code module: ' + name)
        filename = code.co_filename.replace('\\', '/')
        if name in ('eveprefs', 'eveprefs.filebased', 'eveprefs.iniformat'):
            allowed = '/packages/eveprefs/' in filename
        elif name in ('caching', 'caching.lazy', 'caching.memoize'):
            allowed = '/packages/caching/' in filename
        elif name in ('brennivin', 'brennivin.compat', 'brennivin.traceback2', 'traceback2', 'stringutil'):
            suffix = name.replace('.', '/') + ('/__init__.py' if name in ('brennivin', 'traceback2', 'stringutil') else '.py')
            allowed = filename.endswith('/packages/' + suffix)
        else:
            allowed = '/stdlib/' in filename
        if not allowed:
            raise ImportError('Not an installed preference/stdlib module: ' + name)
        return importer


sys.meta_path.insert(0, InstalledPreferencesModules())
# A strictly bounded REAL host interface: these callbacks execute the source
# Windows sharing/retry/file logic. It supplies no engine, paths or readiness.
import _client_prefs_io
sys.modules['blue'] = _client_prefs_io
import eveprefs
from eveprefs.iniformat import IniIniFile

# CPython2 marks frames using a copied builtins dictionary as restricted;
# original old-style classes (including Sissy) then cannot use __dict__.
# Keep the REAL shared builtins dictionary and route only explicit module-local
# import bindings. No per-client session/boot/preferences replace shared values.
import __builtin__
_client_import_fallback = __builtin__.__import__


def _client_scoped_import(name, globals=None, locals=None, fromlist=(), level=-1):
    bindings = globals.get('_CLIENT_IMPORT_BINDINGS') if type(globals) is dict else None
    if level in (-1, 0) and bindings is not None and name in bindings:
        return bindings[name]
    importer = globals.get('_CLIENT_MODULE_IMPORTER') if type(globals) is dict else None
    if importer is not None:
        return importer(name, globals, locals, fromlist, level)
    relative = globals.get('_CLIENT_RELATIVE_IMPORT_BINDINGS') if type(globals) is dict else None
    if level == 1 and relative is not None and name in relative:
        return relative[name]
    if level == -1 and type(globals) is dict and name in globals.get('_CLIENT_ABSOLUTE_IMPORT_NAMES', ()):
        level = 0
    return _client_import_fallback(name, globals, locals, fromlist, level)


__builtin__.__import__ = _client_scoped_import


def _create_original_module_graph(suffixes, bindings, seeds=None):
    # Owned ORIGINAL package bodies, including their real relative imports and
    # reentrant partial modules. No empty parent shells stand in for execution.
    # Unadmitted application dependencies still fail through the real installed
    # module policy; original optional ImportError handlers decide what follows.
    import types, os
    result = types.ModuleType('companion.original_module_graph')
    modules, codes = dict(seeds or {}), {}
    result.modules, result.codes = modules, codes
    result.complete, result.error = False, None

    def load(name):
        parent_name, _, child = name.rpartition('.')
        parent = load(parent_name) if parent_name else None
        if name in modules:
            module = modules[name]
            if parent is not None:
                setattr(parent, child, module)
            return module
        if name not in suffixes:
            raise ImportError('Original module is outside the prepared graph: ' + name)
        prefix = parent_name.replace('.', '/')
        importer = zipimport.zipimporter(_archive + ('/' + prefix if prefix else ''))
        code = importer.get_code(name)
        if code is None or not code.co_filename.replace('\\', '/').endswith(suffixes[name]):
            raise ImportError('Not the installed original module: ' + name)
        module = types.ModuleType(name)
        filename, package = importer.get_filename(name), importer.is_package(name)
        module.__file__, module.__loader__ = filename, importer
        module.__package__ = name if package else parent_name
        if package:
            module.__path__ = [os.path.dirname(filename)]
        module.__dict__.update({'__builtins__': __builtin__.__dict__,
                                '_CLIENT_IMPORT_BINDINGS': bindings,
                                '_CLIENT_MODULE_IMPORTER': import_module})
        # Original exceptions code resolves strx as a builtin when present.
        # The actual effective builtin owner is separate from VM builtins.
        effective = bindings.get('__builtin__')
        if effective is not None and hasattr(effective, 'strx'):
            module.strx = effective.strx
        modules[name], codes[name] = module, code
        try:
            types.FunctionType(code, module.__dict__)()
        except BaseException:
            del modules[name]
            result.error = sys.exc_info()
            raise
        if parent is not None:
            setattr(parent, child, module)
        return module

    def import_module(name, globals=None, locals=None, fromlist=(), level=-1):
        package = globals.get('__package__', '') if type(globals) is dict else ''
        fullname, relative_prefix = name, ''
        if level > 0:
            parts = package.split('.') if package else []
            if level > len(parts):
                raise ValueError('Attempted relative import beyond top-level package')
            relative_prefix = '.'.join(parts[:len(parts) - level + 1])
            fullname = relative_prefix + ('.' + name if name else '')
        elif level == -1 and package:
            candidate = package + '.' + name
            if candidate in suffixes or candidate in modules:
                fullname, relative_prefix = candidate, package
        if fullname not in suffixes and fullname not in modules:
            if level > 0:
                raise ImportError('Relative module is outside the prepared graph: ' + fullname)
            return _client_import_fallback(name, globals, locals, fromlist, 0)
        module = load(fullname)
        if fromlist:
            for child in fromlist:
                candidate = fullname + '.' + child
                if child != '*' and not hasattr(module, child) and (candidate in suffixes or candidate in modules):
                    load(candidate)
            return module
        root = name.split('.')[0]
        return load(relative_prefix + '.' + root if relative_prefix and root else root or fullname)

    result.load = load
    return result


def _create_preferences(root):
    owner = eveprefs.Handler(IniIniFile('prefs', root))
    # Same phase as eveprefs.Init: after constructing the real Handler/INI,
    # before GetValue or preference-driven logging initialization.
    sys.setdefaultencoding(eveprefs.DEFAULT_ENCODING)
    return owner


def _create_logmodule(backend):
    # Materialize only the selected ORIGINAL definitions. Importing the entire
    # modules would require engine/traceback/UI services we have not started.
    import types

    def module_code(name, suffix):
        prefix = name.rpartition('.')[0].replace('.', '/')
        importer = zipimport.zipimporter(_archive + ('/' + prefix if prefix else ''))
        code = importer.get_code(name)
        if code is None or not code.co_filename.replace('\\', '/').endswith(suffix):
            raise ImportError('Not the installed logging module: ' + name)
        return code

    def definition(code, name):
        matches = [value for value in code.co_consts
                   if isinstance(value, types.CodeType) and value.co_name == name]
        if len(matches) != 1:
            raise ImportError('Ambiguous installed logging definition: ' + name)
        return matches[0]

    # A real local output adapter, not blue.LogChannel's native heap type or
    # engine startup. Native callbacks parse the original C API arguments and
    # retain the actual synchronous JS backend channel through a capsule.
    class ClientLogChannelOutput(object):
        __slots__ = ('_native_token', '_facility', '_object')
        flags = {'INFO': 1, 'NOTICE': 32, 'WARN': 2, 'ERR': 4}

        def __init__(self, *args):
            token = backend.create(*args)
            self._native_token = token
            self._facility, self._object = args

        facility = property(lambda self: self._facility)
        object = property(lambda self: self._object)
        channelOpen = property(lambda self: 1)

        def IsOpen(self, *args):
            return backend.is_open(self._native_token, *args)

        def Log(self, *args):
            return backend.log(self._native_token, *args)

        def LogCounter(self, *args):
            return backend.counter(self, *args)

    source = module_code('stdlogutils.logserver', '/packages/stdlogutils/logserver.py')
    wrapper_globals = {'__name__': 'stdlogutils.logserver',
                       '__builtins__': __builtins__,
                       'LogChannel': ClientLogChannelOutput,
                       'LGINFO': 1, 'LGNOTICE': 32, 'LGWARN': 2, 'LGERR': 4}
    wrapper_globals['_LogChannelIsOpen'] = types.FunctionType(
        definition(source, '_LogChannelIsOpen'), wrapper_globals)
    wrapper_body = types.FunctionType(definition(source, 'ChannelWrapper'), wrapper_globals)
    wrapper = type('ChannelWrapper', (ClientLogChannelOutput,), wrapper_body())
    wrapper_globals['ChannelWrapper'] = wrapper
    stream_body = types.FunctionType(definition(source, 'LogChannelStream'), wrapper_globals)
    stream = type('LogChannelStream', (object,), stream_body())
    wrapper_globals['LogChannelStream'] = stream

    module = types.ModuleType('logmodule')
    namespace = module.__dict__
    namespace.update({'__builtins__': __builtins__, 'ChannelWrapper': wrapper,
                      'LogChannelStream': stream, 'Channel': wrapper,
                      'LGINFO': 1, 'LGNOTICE': 32, 'LGWARN': 2, 'LGERR': 4,
                      'baseName': '', 'channels': {}, 'uiMessageFunc': None})
    for name in ('Suppress', 'Unsuppress', 'SuppressAllChannels', 'UnsuppressAllChannels'):
        namespace[name] = getattr(wrapper, name)
    namespace['channelDict'] = wrapper.channelDict
    for name in wrapper.flags:
        namespace[name] = wrapper.flags[name]
        namespace[name.lower()] = wrapper.flags[name]
    source = module_code('logmodule', '/packages/logmodule/__init__.py')
    for name in ('GetChannel', 'init', 'SetUiMessageFunc', 'DefaultUIMessage', 'AddGlobalChannels'):
        # These defaults are the installed module's MAKE_FUNCTION operands;
        # classbody-created methods above retain their original defaults and
        # classmethod descriptors directly from the untouched bytecode.
        defaults = ('', None) if name == 'init' else None
        namespace[name] = types.FunctionType(definition(source, name), namespace, name, defaults)
    # Original order, before any init(base_name, prefs). A constructor failure
    # propagates at its actual point; GetChannel caches only successful calls.
    for variable, name in (('ui', 'UI'), ('general', 'General'),
                           ('methodcalls', 'MethodCalls'), ('unittest', 'Unittest')):
        namespace[variable] = namespace['GetChannel'](name)
    return module


def _create_tasklet_profile(backend):
    # Only these ORIGINAL installed class bodies/functions, with a real local
    # inactive native timer capability. No noop implementation or engine import.
    import types
    code = zipimport.zipimporter(_archive + '/ccpProfile').get_code('ccpProfile.blueTaskletImplementation')
    if code is None or not code.co_filename.replace('\\', '/').endswith('/packages/ccpProfile/blueTaskletImplementation.py'):
        raise ImportError('Not the installed blue tasklet profile')

    def definition(name):
        matches = [value for value in code.co_consts
                   if isinstance(value, types.CodeType) and value.co_name == name]
        if len(matches) != 1:
            raise ImportError('Ambiguous installed tasklet profile definition: ' + name)
        return matches[0]

    pyos = types.ModuleType('companion.tasklet_pyos_capability')
    pyos.taskletTimer = backend
    blue_host = types.ModuleType('companion.tasklet_blue_capability')
    blue_host.pyos = pyos
    module = types.ModuleType('ccpProfile.blueTaskletImplementation')
    namespace = module.__dict__
    namespace.update({'__builtins__': __builtins__, 'blue': blue_host,
                      'EnterTasklet': backend.EnterTasklet,
                      'ReturnFromTasklet': backend.ReturnFromTasklet,
                      'GetCurrent': backend.GetCurrent})
    for name, bases in (('Timer', (object,)), ('TimerPush', None)):
        body = types.FunctionType(definition(name), namespace)
        namespace[name] = type(name, bases or (namespace['Timer'],), body())
    for name in ('PushTimer', 'PopTimer', 'CurrentTimer'):
        namespace[name] = types.FunctionType(definition(name), namespace)
    return module


def _create_static_service_types(wallclock, logging, preferences, high, low, medium, skill):
    # Selected original constructors, not ServiceManager/Run or a ready static
    # service. Native Python owns these classes, dictionaries and method calls.
    import types, dis

    def module_code(name, suffix):
        prefix = name.rpartition('.')[0].replace('.', '/')
        code = zipimport.zipimporter(_archive + ('/' + prefix if prefix else '')).get_code(name)
        if code is None or not code.co_filename.replace('\\', '/').endswith(suffix):
            raise ImportError('Not the installed service module: ' + name)
        return code

    def definition(code, name):
        matches = [value for value in code.co_consts
                   if isinstance(value, types.CodeType) and value.co_name == name]
        if len(matches) != 1:
            raise ImportError('Ambiguous installed service definition: ' + name)
        return matches[0]

    def literal_prefix(code, module_name):
        # Original classbody data prefix only, before its first method code.
        # Empty maps/lists are BUILD_MAP/BUILD_LIST, not co_consts objects.
        # Decode a closed literal instruction set; never execute the unrelated
        # method-definition/default/decorator graph or alter client bytecode.
        namespace, stack, offset = {}, [], 0
        while offset < len(code.co_code):
            opcode = ord(code.co_code[offset])
            offset += 1
            argument = None
            if opcode >= dis.HAVE_ARGUMENT:
                argument = ord(code.co_code[offset]) | ord(code.co_code[offset + 1]) << 8
                offset += 2
            operation = dis.opname[opcode]
            if operation == 'LOAD_CONST':
                value = code.co_consts[argument]
                if isinstance(value, types.CodeType):
                    if stack:
                        raise ImportError('Unexpected service method-default prefix')
                    return namespace
                if not isinstance(value, (type(None), bool, int, long, float, str, unicode, tuple)):
                    raise ImportError('Unexpected service class literal')
                stack.append(value)
            elif operation == 'LOAD_NAME' and code.co_names[argument] == '__name__':
                stack.append(module_name)
            elif operation == 'BUILD_MAP' and argument == 0:
                stack.append({})
            elif operation == 'BUILD_LIST':
                value = stack[-argument:] if argument else []
                if argument:
                    del stack[-argument:]
                stack.append(value)
            elif operation == 'STORE_NAME':
                namespace[code.co_names[argument]] = stack.pop()
            else:
                raise ImportError('Unsupported installed service class prefix: ' + operation)
        raise ImportError('Installed service class has no method boundary')

    constants = types.ModuleType('companion.selected_static_constants')
    constants.effectHiPower, constants.effectLoPower = high, low
    constants.effectMedPower, constants.effectSkillEffect = medium, skill
    clock = types.ModuleType('companion.service_wallclock')
    clock.GetWallclockTimeNow = wallclock
    host = types.ModuleType('companion.service_clock_capability')
    host.os = clock
    service_constants = {'__builtins__': __builtins__}
    types.FunctionType(module_code('carbon.common.script.sys.serviceConst',
                                   '/carbon/common/script/sys/serviceConst.py'), service_constants)()
    core_code = definition(module_code('carbon.common.script.sys.service',
                                      '/carbon/common/script/sys/service.py'), 'CoreService')
    core_globals = {'__name__': 'carbon.common.script.sys.service',
                    '__builtins__': __builtins__, 'blue': host, 'log': logging,
                    'prefs': preferences, 'SERVICE_STOPPED': service_constants['SERVICE_STOPPED']}
    core_namespace = literal_prefix(core_code, core_globals['__name__'])
    for name in ('__init__', 'InitService', '__getattr__', '__setattr__'):
        core_namespace[name] = types.FunctionType(definition(core_code, name), core_globals)
    core = type('CoreService', (object,), core_namespace)
    core_globals['CoreService'] = core
    # boot/counter services remain absent: the ORIGINAL static class has empty
    # config/counters. Their other branches are not a constructed capability.
    base_code = definition(module_code('eve.common.script.dogma.baseDogmaStaticSvc',
                                      '/eve/common/script/dogma/baseDogmaStaticSvc.py'), 'BaseDogmaStaticSvc')
    base_globals = {'__name__': 'eve.common.script.dogma.baseDogmaStaticSvc',
                    '__builtins__': __builtins__, 'Service': core, 'const': constants}
    base_namespace = literal_prefix(base_code, base_globals['__name__'])
    base_namespace['__init__'] = types.FunctionType(definition(base_code, '__init__'), base_globals)
    base = type('BaseDogmaStaticSvc', (core,), base_namespace)
    client_code = definition(module_code('eve.client.script.dogma.clientDogmaStaticSvc',
                                        '/eve/client/script/dogma/clientDogmaStaticSvc.py'), 'ClientDogmaStaticSvc')
    client = type('ClientDogmaStaticSvc', (base,), literal_prefix(client_code, 'eve.client.script.dogma.clientDogmaStaticSvc'))
    result = types.ModuleType('companion.static_constructor_types')
    result.CoreService, result.BaseDogmaStaticSvc, result.ClientDogmaStaticSvc = core, base, client
    return result


def _load_cfsd(name, pyd, data):
    # Called only with the JS provider's indexed, hashed local inputs. Keep the
    # original extension and its real heap wrappers; no JSON row projection.
    import imp, os
    module = imp.load_dynamic(name, pyd)
    if os.path.normcase(os.path.abspath(module.__file__)) != os.path.normcase(os.path.abspath(pyd)):
        raise ImportError('Installed cFSD module path differs: ' + name)
    result = module.load(data)
    if result is None:
        raise IOError('Installed cFSD loader returned no data: ' + name)
    return result


def _attach_static_attribute_data(service_types, raw, constant_values):
    import types
    from collections import defaultdict

    def module_code(name, suffix):
        prefix = name.rpartition('.')[0].replace('.', '/')
        code = zipimport.zipimporter(_archive + ('/' + prefix if prefix else '')).get_code(name)
        if code is None or not code.co_filename.replace('\\', '/').endswith(suffix):
            raise ImportError('Not the installed static data module: ' + name)
        return code

    def definition(code, name):
        matches = [value for value in code.co_consts
                   if isinstance(value, types.CodeType) and value.co_name == name]
        if len(matches) != 1:
            raise ImportError('Ambiguous installed static data definition: ' + name)
        return matches[0]

    # Execute the ORIGINAL memoizer, including its real native time/stdlib
    # cache semantics. Its optional locks import follows its own ImportError
    # path here; MemoizeWithLock is not selected or fabricated as available.
    from caching.memoize import Memoize as memoize

    loader_globals = {'__name__': 'fsdBuiltData.common.base',
                      '__builtins__': __builtins__, 'NO_BINARY_LOADER': object()}
    loader_code = definition(module_code('fsdBuiltData.common.base',
                                        '/packages/fsdBuiltData/common/base.py'), 'BuiltDataLoader')
    loader = type('BuiltDataLoader', (object,), types.FunctionType(loader_code, loader_globals)())
    # Prepare the real binary, then use the ORIGINAL cached GetData path. The
    # resource/autobuild/engine load and disk-watching paths remain unconfigured;
    # they are not replaced with a successful fake loader or a reload callback.
    data_source = module_code('dogma.data', '/packages/dogma/data.py')
    data = types.ModuleType('dogma.data')
    namespace = data.__dict__
    namespace.update({'__builtins__': __builtins__, 'defaultdict': defaultdict,
                      'dogmaAttributesLoader': sys.modules['dogmaAttributesLoader']})
    attributes_body = types.FunctionType(definition(data_source, 'DogmaAttributes'), namespace)
    attributes = type('DogmaAttributes', (loader,), attributes_body())
    attributes.__binary__ = raw
    namespace['DogmaAttributes'] = attributes
    namespace['attributeDataTypeTypeDamage'] = constant_values['attributeDataTypeTypeDamage']
    memoized = ('get_all_attributes_by_name', 'get_attribute_list_by_data_type',
                'get_charge_recharge_time_attributes_by_id', 'get_attribute_list_by_charge_recharge_time_id')
    for name in ('_get_dogma_attributes', 'get_all_attributes', 'get_all_attributes_by_id',
                 'get_all_attributes_by_name', 'get_attribute_list_by_data_type',
                 'get_charge_recharge_time_attributes_by_id', 'get_attributes_by_charge_recharge_time_id',
                 'get_attribute_list_by_charge_recharge_time_id'):
        function = types.FunctionType(definition(data_source, name), namespace)
        namespace[name] = memoize(function) if name in memoized else function
    base = service_types.BaseDogmaStaticSvc
    globals = base.__dict__['__init__'].func_globals
    for name, value in constant_values.iteritems():
        setattr(globals['const'], name, value)
    globals['dogma_data'] = data
    base_source = module_code('eve.common.script.dogma.baseDogmaStaticSvc',
                              '/eve/common/script/dogma/baseDogmaStaticSvc.py')
    base.LoadAttributes = types.FunctionType(definition(definition(base_source, 'BaseDogmaStaticSvc'),
                                                       'LoadAttributes'), globals)
    return data


def _attach_static_phases(service_types, data, raw_type_dogma, raw_effects, raw_types, constant_values):
    # Extend THIS client's original data namespace and classes. Native roots,
    # captured rows, defaultdict misses and memoizer lifetimes stay Python's.
    import types
    from collections import defaultdict, namedtuple
    from caching.memoize import Memoize as memoize

    def module_code(name, suffix):
        prefix = name.rpartition('.')[0].replace('.', '/')
        code = zipimport.zipimporter(_archive + ('/' + prefix if prefix else '')).get_code(name)
        if code is None or not code.co_filename.replace('\\', '/').endswith(suffix):
            raise ImportError('Not the installed static phase module: ' + name)
        return code

    def definition(code, name):
        matches = [value for value in code.co_consts
                   if isinstance(value, types.CodeType) and value.co_name == name]
        if len(matches) != 1:
            raise ImportError('Ambiguous installed static phase definition: ' + name)
        return matches[0]

    base = service_types.BaseDogmaStaticSvc
    base_globals = base.__dict__['__init__'].func_globals
    if base_globals['dogma_data'] is not data:
        raise ValueError('Static phase data belongs to another native service')
    const = base_globals['const']
    for name, value in constant_values.iteritems():
        setattr(const, name, value)
    namespace = data.__dict__
    loader = data.DogmaAttributes.__bases__[0]
    source = module_code('dogma.data', '/packages/dogma/data.py')
    for name, extension, raw in (('TypeDogma', 'typeDogmaLoader', raw_type_dogma),
                                 ('DogmaEffects', 'dogmaEffectsLoader', raw_effects)):
        namespace[extension] = sys.modules[extension]
        body = types.FunctionType(definition(source, name), namespace)
        cls = type(name, (loader,), body())
        cls.__binary__ = raw
        namespace[name] = cls

    # Actual installed evetypes physical getters and exceptions. Its other
    # localization/group/engine APIs are not fabricated by this selected host.
    evetypes = types.ModuleType('evetypes')
    type_globals = evetypes.__dict__
    type_globals['__builtins__'] = __builtins__
    types_data = types.ModuleType('evetypes.data')
    types_data.__dict__.update({'__builtins__': __builtins__, 'typesLoader': sys.modules['typesLoader']})
    type_source = module_code('evetypes.data', '/packages/evetypes/data.py')
    body = types.FunctionType(definition(type_source, 'Types'), types_data.__dict__)
    types_data.Types = type('Types', (loader,), body())
    types_data.Types.__binary__ = raw_types
    type_globals['Types'] = types_data.Types
    evetypes.data = types_data
    type_source = module_code('evetypes', '/packages/evetypes/__init__.py')
    for name in ('TypeNotFoundException', 'TypeAttributeNotFoundException'):
        body = types.FunctionType(definition(type_source, name), type_globals)
        type_globals[name] = type(name, (Exception,), body())
    for name in ('GetTypes', 'GetType', '_GetAttributeForType', 'Exists',
                 'GetMass', 'GetCapacity', 'GetVolume', 'GetRadius'):
        type_globals[name] = types.FunctionType(definition(type_source, name), type_globals)
    namespace['evetypes'] = evetypes
    identity = types.ModuleType('dogma.identity')
    identity.__dict__['__builtins__'] = __builtins__
    identity_source = module_code('dogma.identity', '/packages/dogma/identity.py')
    namespace['get_safe_dogma_identity'] = types.FunctionType(
        definition(identity_source, 'get_safe_dogma_identity'), identity.__dict__)
    namespace['DogmaTypeAttribute'] = namedtuple('DogmaTypeAttribute', ['attributeID', 'value'])
    namespace['DogmaTypeAttribute'].__module__ = 'dogma.data'
    for name in ('attributeMass', 'attributeCapacity', 'attributeVolume', 'attributeRadius'):
        namespace[name] = constant_values[name]
    memoized = ('get_type_attributes', 'get_type_attributes_by_id',
                'get_all_effects_by_name', 'get_all_effects_by_id', 'get_all_type_ids_and_effects',
                'get_effects_indexed_by_type_id_and_effect_id', 'get_effects_indexed_by_effect_id_and_type_id')
    for name in ('_get_type_dogma', 'get_type_dogma', 'get_type_attributes',
                 'has_type_attributes', 'get_type_attributes_by_id', 'get_type_attribute',
                 '_get_effects', 'get_all_effects_by_name', 'get_all_effects_by_id',
                 'get_all_type_ids_and_effects', 'get_effects_indexed_by_type_id_and_effect_id',
                 'get_effects_indexed_by_effect_id_and_type_id'):
        defaults = (None,) if name == 'get_type_attribute' else None
        function = types.FunctionType(definition(source, name), namespace, name, defaults)
        namespace[name] = memoize(function) if name in memoized else function

    client_globals = {'__name__': 'eve.client.script.dogma.clientDogmaStaticSvc',
                      '__builtins__': __builtins__, 'defaultdict': defaultdict,
                      'dogma_data': data, 'const': const, 'evetypes': evetypes}
    client_source = module_code('eve.client.script.dogma.clientDogmaStaticSvc',
                                '/eve/client/script/dogma/clientDogmaStaticSvc.py')
    for name in ('AttributesByTypeLookupDict', 'AttributesByTypeAttribute'):
        body = types.FunctionType(definition(client_source, name), client_globals)
        client_globals[name] = type(name, (defaultdict,), body())
    client_code = definition(client_source, 'ClientDogmaStaticSvc')
    service_types.ClientDogmaStaticSvc.LoadTypeAttributes = types.FunctionType(
        definition(client_code, 'LoadTypeAttributes'), client_globals)
    base_source = definition(module_code('eve.common.script.dogma.baseDogmaStaticSvc',
                                        '/eve/common/script/dogma/baseDogmaStaticSvc.py'), 'BaseDogmaStaticSvc')
    for name in ('get_effects_indexed_by_type_id_and_effect_id', 'get_effects_indexed_by_effect_id_and_type_id'):
        base_globals[name] = namespace[name]
    base_globals['evetypes'] = evetypes
    for name in ('LoadEffects', 'LoadTypeEffects', 'GetTypeAttribute', 'GetTypeAttribute2', 'GetTypeAttributes'):
        defaults = (False,) if name == 'LoadTypeEffects' else (None,) if name == 'GetTypeAttribute' else None
        setattr(base, name, types.FunctionType(definition(base_source, name), base_globals, name, defaults))
    return evetypes


def _create_localization_settings(boot_root, preferences):
    # Actual read-only start/common INI snapshots and private original helper
    # namespaces. This is a settings/cleaner field phase, not eveprefs.Init or
    # Localization.LoadLanguageData, a parser, session or engine readiness.
    import types, re, __builtin__
    boot = eveprefs.Handler(IniIniFile('start', boot_root, 1))
    common = IniIniFile('common', boot_root, 1)
    boot.keyval.update(common.keyval)

    def module_code(name, suffix):
        prefix = name.rpartition('.')[0].replace('.', '/')
        code = zipimport.zipimporter(_archive + ('/' + prefix if prefix else '')).get_code(name)
        if code is None or not code.co_filename.replace('\\', '/').endswith(suffix):
            raise ImportError('Not the installed localization settings module: ' + name)
        return code

    def definition(code, name):
        matches = [value for value in code.co_consts
                   if isinstance(value, types.CodeType) and value.co_name == name]
        if len(matches) != 1:
            raise ImportError('Ambiguous installed localization definition: ' + name)
        return matches[0]

    # Only this private import binding supplies real owners. Never replace the
    # process-global eveprefs.boot/prefs used by other emulated clients.
    owned_prefs = types.ModuleType('eveprefs')
    owned_prefs.boot, owned_prefs.prefs = boot, preferences
    original_import = __builtin__.__import__

    def owner_import(name, globals=None, locals=None, fromlist=(), level=-1):
        if name == 'eveprefs':
            return owned_prefs
        return original_import(name, globals, locals, fromlist, level)

    builtins = dict(__builtin__.__dict__)
    builtins['__import__'] = owner_import

    def original_module(name, suffix):
        module = types.ModuleType(name)
        # These private namespaces are not registered as application packages.
        # Their original imports are absolute; avoid Python2's implicit relative
        # lookup through an unrelated/missing shared localization package.
        module.__package__ = ''
        module.__dict__['__builtins__'] = builtins
        types.FunctionType(module_code(name, suffix), module.__dict__)()
        return module

    internal = original_module('localization.internalUtil', '/packages/localization/internalUtil.py')
    qa = original_module('localization.settings.qaSettings', '/packages/localization/settings/qaSettings.py')
    bilingual = original_module('localization.settings.bilingualSettings', '/packages/localization/settings/bilingualSettings.py')
    constants = original_module('localization.const', '/packages/localization/const.py')
    commonutils = types.ModuleType('carbon.common.script.util.commonutils')
    commonutils.__dict__.update({'__builtins__': builtins, 're': re})
    source = module_code('carbon.common.script.util.commonutils', '/carbon/common/script/util/commonutils.py')
    commonutils.StripTags = types.FunctionType(definition(source, 'StripTags'), commonutils.__dict__, 'StripTags', ((), ()))
    namespace = {'__name__': 'localization.localizationBase', '__builtins__': builtins,
                 'internalUtil': internal, 'qaSettings': qa, 'bilingualSettings': bilingual,
                 'commonutils': commonutils, 'locconst': constants}
    source = definition(module_code('localization.localizationBase', '/packages/localization/localizationBase.py'), 'Localization')
    methods = {'__module__': 'companion.localization_settings'}
    for name in ('_GetPrimaryLanguage', 'HighlightImportant', 'UseImportantTooltip',
                 '_QaTooltipOverride', 'CleanImportantMarkup'):
        methods[name] = types.FunctionType(definition(source, name), namespace)
    selected = type('ClientLocalizationSettings', (object,), methods)()
    # The four source constructor setting fields, plus the actual original
    # primary-language constant used by settings comparisons. No text/language
    # parser is published or told that its data has loaded by this operation.
    selected._importantNameSetting = None
    selected._languageTooltipSetting = None
    selected._qaTooltipOverride = None
    selected._highlightImportantSetting = None
    selected._primaryLanguageID = selected._GetPrimaryLanguage()
    result = types.ModuleType('companion.localization_settings_owner')
    result.boot, result.common, result.preferences = boot, common, preferences
    result.internal, result.qa, result.bilingual = internal, qa, bilingual
    result.settings, result.constants, result.commonutils = selected, constants, commonutils
    return result


def _prepare_localization_data(extension, main_filename, english_filename):
    # Explicit host extension/indexed-file I/O phase. The actual installed
    # cPickle and native module own full tuples, metadata and token dictionaries.
    # This does not execute Blue.LoadExtension/ResFile/statistics zones or the
    # original Localization loader/constructor and does not register handlers.
    import imp, os, cPickle, types
    backend = imp.load_dynamic('_evelocalization', extension)
    if os.path.normcase(os.path.abspath(backend.__file__)) != os.path.normcase(os.path.abspath(extension)):
        raise ImportError('Installed localization module path differs')
    with open(main_filename, 'rb') as source:
        main = cPickle.loads(source.read())
    with open(english_filename, 'rb') as source:
        english = cPickle.loads(source.read())
    if not isinstance(main, dict) or not isinstance(english, tuple) or len(english) != 2 or english[0] != 'en-us' or not isinstance(english[1], dict):
        raise ValueError('Unexpected installed main/English localization data')
    backend.SetPrimaryLanguage(english[0])
    backend.LoadMessageData(*english)
    result = types.ModuleType('companion.native_localization_data')
    result.backend, result.main, result.english = backend, main, english
    return result


def _create_session_context(field_state=None):
    # Original localstorage/Sissy, with actual Stackless getcurrent and a
    # PRIVATE builtin namespace. The bounded transport-field object is not a
    # constructed CoreSession, its default policy or engine lifecycle.
    import types, __builtin__, stackless
    if hasattr(stackless.getcurrent(), 'localStorage'):
        raise RuntimeError('Per-tasklet shared localStorage requires an owned entry context')
    owned_builtins = types.ModuleType('__builtin__')
    owned_builtins.__dict__.update(__builtin__.__dict__)
    source = zipimport.zipimporter(_archive).get_code('localstorage')
    if source is None or not source.co_filename.replace('\\', '/').endswith('/packages/localstorage/__init__.py'):
        raise ImportError('Not the installed localstorage module')
    storage = types.ModuleType('localstorage')
    storage.__dict__.update({'__builtins__': __builtin__.__dict__, '__package__': '',
                             '_CLIENT_IMPORT_BINDINGS': {'__builtin__': owned_builtins}})
    types.FunctionType(source, storage.__dict__)()
    fields = field_state if field_state is not None else type('CurrentTransportSessionFields', (object,), {'__module__': 'companion.transport_session_fields'})()

    def assert_entry():
        # Stackless creates a new current tasklet at separate embedding calls.
        # The native addon enforces one Node environment/Windows owner thread;
        # ORIGINAL GetLocalStorage uses this namespace's real main fallback.
        if hasattr(stackless.getcurrent(), 'localStorage'):
            raise RuntimeError('Session context requires native owner entries without shared tasklet storage')

    def publish(values):
        assert_entry()
        fields.__dict__.clear()
        fields.__dict__.update(values)
        storage.GetLocalStorage()['base.session'] = fields

    def retire():
        assert_entry()
        storage.GetLocalStorage().pop('base.session', None)

    result = types.ModuleType('companion.session_context')
    result.localstorage, result.builtins = storage, owned_builtins
    result.session, result.fields = owned_builtins.session, fields
    result.publish, result.retire, result.assert_entry = publish, retire, assert_entry
    return result


def _create_effective_session_context(preferences, boot):
    # A named FIELD phase, not Session.__init__/__ChangeAttribute or the engine
    # lifecycle. Definitions/literals and pure field helpers are original code;
    # clocks, indexes, history and service broadcasts are not run. Original
    # masks are a synchronous native-entry capability on this SAME field owner.
    import types, __builtin__, dis, weakref

    def module_code(name, suffix):
        prefix = name.rpartition('.')[0].replace('.', '/')
        code = zipimport.zipimporter(_archive + ('/' + prefix if prefix else '')).get_code(name)
        if code is None or not code.co_filename.replace('\\', '/').endswith(suffix):
            raise ImportError('Not the installed session field module: ' + name)
        return code

    def definition(code, name):
        matches = [value for value in code.co_consts if type(value) is types.CodeType and value.co_name == name]
        if len(matches) != 1:
            raise ImportError('Ambiguous installed session field definition: ' + name)
        return matches[0]

    constants = types.ModuleType('carbon.common.script.sys.serviceConst')
    constants.__dict__['__builtins__'] = __builtin__.__dict__
    types.FunctionType(module_code(constants.__name__, '/carbon/common/script/sys/serviceConst.py'), constants.__dict__)()
    session_constants = types.ModuleType('carbon.common.lib.session')
    session_constants.__dict__['__builtins__'] = __builtin__.__dict__
    types.FunctionType(module_code(session_constants.__name__, '/carbon/common/lib/session.py'), session_constants.__dict__)()
    stringutil = types.ModuleType('stringutil')
    stringutil.__dict__['__builtins__'] = __builtin__.__dict__
    types.FunctionType(module_code('stringutil', '/packages/stringutil/__init__.py'), stringutil.__dict__)()
    # machobase's actual mode assignment is boot.role. This selected data input
    # does not import/construct its network, locks or blue engine dependencies.
    mode = types.ModuleType('companion.installed_client_mode')
    mode.mode = boot.role
    if mode.mode != 'client':
        raise ValueError('Effective client fields require installed boot.role client')
    namespace = {'__name__': 'carbon.common.script.sys.basesession', '__builtins__': __builtin__.__dict__,
                 'ROLE_LOGIN': constants.ROLE_LOGIN, 'prefs': preferences, 'strx': stringutil.strx, 'machobase': mode}
    source = module_code('carbon.common.script.sys.basesession', '/carbon/common/script/sys/basesession.py')
    # autoexec_client_core102 creates the CLIENT session before login with a
    # locally generated SID. It is not a SID copied from server packets. Own
    # the entire original stdlib Random namespace and its genuine native RNG.
    session_random = types.ModuleType('random')
    session_random.__dict__['__builtins__'] = __builtin__.__dict__
    types.FunctionType(module_code('random', '/stdlib/random.py'), session_random.__dict__)()
    namespace['random'] = session_random
    namespace['GetNewSid'] = types.FunctionType(definition(source, 'GetNewSid'), namespace)
    # Class bodies only create definitions and literals. No whole module import:
    # basesession also starts an ObjectKillah scheduler at module scope.
    core = types.ClassType('CoreSession', (), types.FunctionType(definition(source, 'CoreSession'), namespace)())
    namespace['CoreSession'] = core
    original = types.ClassType('Session', (core,), types.FunctionType(definition(source, 'Session'), namespace)())
    # Original client-local UUID graph, shared by this client's session fields.
    # Wrappers retain weak proxies; their network service calls are not admitted
    # by this field phase. Never import basesession's module-level scheduler.
    namespace.update({'weakref': weakref, 'sys': sys, 'objectUUID': 0L,
                      'objectsByUUID': weakref.WeakValueDictionary({})})
    for name in ('ObjectcastCallWrapper', 'UpdatePublicAttributesCallWrapper'):
        namespace[name] = types.ClassType(name, (), types.FunctionType(definition(source, name), namespace)())
    for name in ('GetObjectUUID', 'GetObjectByUUID'):
        namespace[name] = types.FunctionType(definition(source, name), namespace)
    selected = {'__module__': 'companion.effective_session_fields',
                '__persistvars__': original.__persistvars__,
                '__attributesWithDefaultValueOfZero__': original.__attributesWithDefaultValueOfZero__}
    for name in ('GetDefaultValueOfAttribute', 'ComputeNotifySets', 'Masquerade', 'GetActualSession',
                 'RegisterMachoObjectConnection', 'UnregisterMachoObjectConnection'):
        selected[name] = core.__dict__[name]
    selected['__repr__'] = core.__dict__['__repr__']
    for name in ('RecalculateDependantAttributes', 'RecalculateDependantAttributesWithChanges'):
        selected[name] = original.__dict__[name]
    state = type('EffectiveTransportSessionFields', (object,), selected)()
    for name in original.__persistvars__ + ['locationid', 'corprole']:
        state.__dict__[name] = state.GetDefaultValueOfAttribute(name)
    state.__dict__['sessionType'] = session_constants.SESSION_TYPE_GAME
    state.__dict__['sid'] = namespace['GetNewSid']()  # Selected CreateSession/GetNewSid -> CoreSession.sid input.
    state.__dict__['machoObjectConnectionsByObjectID'] = {}  # Original CoreSession647 literal.

    def display_list(name):
        # Read only the original constructor's closed literal assignment.
        # Do not execute a sliced constructor or invent its engine fields.
        code = original.__dict__['__init__'].func_code
        instructions, cursor = [], 0
        while cursor < len(code.co_code):
            opcode = ord(code.co_code[cursor])
            cursor += 1
            argument = None
            if opcode >= dis.HAVE_ARGUMENT:
                argument = ord(code.co_code[cursor]) | (ord(code.co_code[cursor + 1]) << 8)
                cursor += 2
            if opcode == dis.opmap['EXTENDED_ARG']:
                raise ImportError('Unsupported session display literal instruction')
            instructions.append((opcode, argument))
        positions = [i for i, (op, arg) in enumerate(instructions)
                     if op == dis.opmap['STORE_ATTR'] and code.co_names[arg] == name]
        if len(positions) != 1:
            raise ImportError('Ambiguous session display list: ' + name)
        index = positions[0]
        if instructions[index - 1] != (dis.opmap['LOAD_FAST'], 0) or instructions[index - 2][0] != dis.opmap['BUILD_LIST']:
            raise ImportError('Unexpected session display assignment: ' + name)
        count = instructions[index - 2][1]
        entries = instructions[index - 2 - count:index - 2]
        if len(entries) != count or any(op != dis.opmap['LOAD_CONST'] or type(code.co_consts[arg]) is not str for op, arg in entries):
            raise ImportError('Session display list is not a closed string literal: ' + name)
        return [code.co_consts[arg] for op, arg in entries]

    state.additionalAttributesToPrint = display_list('additionalAttributesToPrint')
    state.additionalHexAttributes = display_list('additionalHexAttributes')
    result = _create_session_context(state)
    namespace.update({'weakref': weakref, 'localstorage': result.localstorage})
    mask = type('MasqueradeMask', (object,), types.FunctionType(definition(source, 'MasqueradeMask'), namespace)())
    namespace['MasqueradeMask'] = mask

    # MachoNetService's selected LOCAL identity field/getter, not its service,
    # transport/authenticating/queue/dirty-session or reconnect lifecycle.
    # A newly constructed companion client owner owns this counter; replacing
    # only a socket must not construct another identity owner and reset it.
    macho_source = module_code('carbon.common.script.net.machoNet', '/carbon/common/script/net/machoNet.py')
    macho_class = definition(macho_source, 'MachoNetService')
    connection_namespace = {'__name__': 'carbon.common.script.net.machoNet', '__builtins__': __builtin__.__dict__,
                            'macho': mode, 'session': result.session}
    connection = type('ClientConnectionIdentityFields', (object,), {
        '__module__': 'companion.client_connection_fields',
        'GetClientSessionID': types.FunctionType(definition(macho_class, 'GetClientSessionID'), connection_namespace)})()
    connection.clientSessionID = 0  # Original client-only constructor literal, machoNet462.

    def begin_connect_attempt():
        # Named source port of ConnectToServer1565, before dirty validation and
        # second compatibility/auth exchange. Keep native PyInt += literal1,
        # including actual Python2 promotion; never import a transport ID.
        result.assert_entry()
        connection.clientSessionID += 1

    result.connection_fields, result.begin_connect_attempt = connection, begin_connect_attempt
    # ObjectCall's connection-field phase belongs to the client BEFORE login,
    # not to each later inventory/Godma owner. No fake synchronous RPC service.
    object_call_fields = type('ObjectCallConnectionFields', (object,), {
        '__module__': 'companion.object_call_connection_fields'})()
    object_call_fields.machoNet, object_call_fields.releasedObjects = connection, {}
    result.object_call_fields = object_call_fields

    def release_calls():
        # Named source port of ObjectCallGPCS35-65's one awake iteration.
        # The real transport-owned wallclock loop supplies the 30000ms wait.
        # Detach FIRST; reentrant releases belong to the new queue. Preserve
        # native dict order, weak-proxy errors, all duplicate pairs and maxima.
        if object_call_fields.releasedObjects:
            tmp = object_call_fields.releasedObjects
            object_call_fields.releasedObjects = {}
            chrto = {}
            for object_id, entries in tmp.iteritems():
                for ref_id, sess, destination in entries:
                    if hasattr(destination, 'nodeID'):
                        try:
                            if object_id not in sess.machoObjectConnectionsByObjectID:
                                key = (sess.sid, destination.nodeID)
                                if key in chrto:
                                    chrto[key][2].append((object_id, ref_id))
                                else:
                                    chrto[key] = [sess, destination, [(object_id, ref_id)]]
                        except ReferenceError:
                            sys.exc_clear()
            for group in chrto.itervalues():
                minus = {}
                for object_id, ref_id in group[2]:
                    if object_id in minus:
                        minus[object_id] = max(ref_id, minus[object_id])
                    else:
                        minus[object_id] = ref_id
                # One send before advancing to the next group, as the source.
                yield group[0], group[1], group[2], minus

    def next_release(iterator):
        try:
            return iterator.next()
        except StopIteration:
            return None

    result.release_calls, result.next_release = release_calls, next_release

    def run_masked(callback, arguments=(), props=None):
        # One embedding entry owns the entire ORIGINAL mask/callback/unmask.
        # No mask spans a JS await or a different Stackless current tasklet.
        # Original SetLocalStorage chooses tasklet storage or its real private
        # main fallback; do not replace it or make UnMask idempotent.
        result.assert_entry()
        active_mask = state.Masquerade(props)
        try:
            return callback(*arguments)
        finally:
            active_mask.UnMask()

    def restore_current():
        result.assert_entry()
        result.localstorage.GetLocalStorage()['base.session'] = state

    def receive(changes, initial):
        result.assert_entry()
        if state.role & constants.ROLE_SERVICE:
            raise RuntimeError('A service session cannot receive client field changes')
        if initial:
            state.RecalculateDependantAttributes(changes)
        else:
            state.RecalculateDependantAttributesWithChanges(changes)
        notify, disappeared = state.ComputeNotifySets(changes, pairs=not initial)
        if 'userid' in notify and notify['userid'][0] and notify['userid'][1]:
            raise RuntimeError("A session's userID may not change")
        # The bounded field commit retains the EXACT old object on native ==.
        # This is deliberately not __ChangeAttribute's simclock/index lifecycle.
        for name in notify:
            state.__dict__[name] = changes[name] if initial else changes[name][1]
        result.last_notify, result.last_disappeared = notify, disappeared
        restore_current()
        return notify, disappeared

    del result.publish  # Effective state is never rebuilt from a raw snapshot.
    result.restore_current, result.receive = restore_current, receive
    result.run_masked, result.MasqueradeMask = run_masked, mask
    result.wire_pair = lambda old, new: (old, new)
    result.preferences, result.boot, result.source_classes = preferences, boot, (core, original)
    result.get_object_uuid, result.get_object_by_uuid = namespace['GetObjectUUID'], namespace['GetObjectByUUID']
    result.objects_by_uuid = namespace['objectsByUUID']
    result.get_new_sid, result.session_random = namespace['GetNewSid'], session_random
    result.last_notify, result.last_disappeared = {}, set()
    restore_current()
    return result


def _create_std_logging(logmodule, preferences, context):
    # Entire original stdlib logging namespace per client: real root, Manager,
    # locks, Handler, records, exception handling and atexit registration. No
    # shared logging.root broadcast and no replacement formatter/error sink.
    import types, __builtin__, os
    context.assert_entry()
    if context.preferences is not preferences or context.boot.role != 'client':
        raise ValueError('Logging must share actual effective client field owners')

    def module_code(name, suffix):
        prefix = name.rpartition('.')[0].replace('.', '/')
        importer = zipimport.zipimporter(_archive + ('/' + prefix if prefix else ''))
        code = importer.get_code(name)
        if code is None or not code.co_filename.replace('\\', '/').endswith(suffix):
            raise ImportError('Not the installed logging dependency: ' + name)
        return importer, code

    def definition(code, name):
        matches = [value for value in code.co_consts if type(value) is types.CodeType and value.co_name == name]
        if len(matches) != 1:
            raise ImportError('Ambiguous installed logging definition: ' + name)
        return matches[0]

    owned_prefs = types.ModuleType('eveprefs')
    owned_prefs.boot, owned_prefs.prefs = context.boot, preferences
    bindings = {'__builtin__': context.builtins, 'eveprefs': owned_prefs}
    # These original absolute dependencies are shared real modules. Resolve
    # them explicitly so Python2 does not attempt implicit relative lookup in
    # private application packages that are deliberately absent from sys.modules.
    for dependency in ('sys', 'os', 'time', 'cStringIO', 'traceback', 'warnings',
                       'weakref', 'codecs', 'thread', 'threading', 'atexit',
                       'fnmatch', 'zlib', 'traceback2', 'stringutil'):
        bindings[dependency] = _client_import_fallback(dependency, globals(), locals(), (), 0)

    def original_module(name, suffix):
        importer, code = module_code(name, suffix)
        module = types.ModuleType(name)
        # Preserve actual zipimport metadata, including .pyj __file__. Its
        # logging._srcfile need not equal embedded BuildAgent co_filename.
        filename, package = importer.get_filename(name), importer.is_package(name)
        module.__file__, module.__loader__ = filename, importer
        module.__package__ = name if package else name.rpartition('.')[0]
        if package:
            module.__path__ = [os.path.dirname(filename)]
        module.__dict__.update({'__builtins__': __builtin__.__dict__,
                                '_CLIENT_IMPORT_BINDINGS': bindings,
                                'session': context.session})
        if name == 'stdlogutils':
            # Both absolute devenv and stdlogutils/devenv are absent from the
            # pinned archive. Perform the real failed absolute import without
            # a private-parent warning; the original try/except still runs.
            module.__dict__['_CLIENT_ABSOLUTE_IMPORT_NAMES'] = ('devenv',)
        types.FunctionType(code, module.__dict__)()
        return module

    logging = original_module('logging', '/stdlib/logging/__init__.py')
    bindings['logging'] = logging
    helpers = original_module('brennivin.logutils', '/packages/brennivin/logutils.py')
    bindings['brennivin.logutils'] = helpers
    stdlogutils = original_module('stdlogutils', '/packages/stdlogutils/__init__.py')
    bindings['stdlogutils'] = stdlogutils
    _, code = module_code('stdlogutils.logserver', '/packages/stdlogutils/logserver.py')
    logserver = types.ModuleType('stdlogutils.logserver')
    namespace = logserver.__dict__
    namespace.update({'__builtins__': __builtin__.__dict__, '_CLIENT_IMPORT_BINDINGS': bindings,
                      'logging': logging, 'stdlogutils': stdlogutils,
                      'ChannelWrapper': logmodule.ChannelWrapper})
    # Original source LEVEL_MAP resolves these real logging/channel constants.
    namespace['LEVEL_MAP'] = {logging.CRITICAL: logmodule.LGERR, logging.ERROR: logmodule.LGERR,
                             logging.WARNING: logmodule.LGWARN, logging.INFO: logmodule.LGINFO,
                             logging.DEBUG: logmodule.LGINFO, logging.NOTSET: logmodule.LGINFO}
    body = types.FunctionType(definition(code, 'LogServerHandler'), namespace)()
    namespace['LogServerHandler'] = type('LogServerHandler', (logging.Handler,), body)
    for name in ('GetLoggingLevelFromPrefs', 'InitLoggingToLogserver'):
        namespace[name] = types.FunctionType(definition(code, name), namespace)
    # Same original startup order as autoexec: init the EXISTING wrapper/mask,
    # then install original handler/FMT_EVE with original preference mapping.
    logmodule.init(context.boot.role, preferences)
    logserver.InitLoggingToLogserver(logserver.GetLoggingLevelFromPrefs())
    result = types.ModuleType('companion.std_logging_owner')
    result.logging, result.stdlogutils, result.logserver = logging, stdlogutils, logserver
    result.formatter, result.root = stdlogutils.Fmt.FMT_EVE, logging.root
    result.context, result.preferences, result.boot = context, preferences, context.boot
    return result


def _attach_error_logging(logmodule, stdlogutils, context, tasklet_timer, arguments):
    # Original selected error graph on the EXISTING logmodule and owners.
    # This is the client/pre-UI profile, not SettingsSvc/ServiceManager startup,
    # scheduler/popups/alerts, memory diagnostics or a constructed Blue engine.
    import types, __builtin__, datetime, traceback2, cStringIO

    def module_code(name, suffix):
        prefix = name.rpartition('.')[0].replace('.', '/')
        code = zipimport.zipimporter(_archive + ('/' + prefix if prefix else '')).get_code(name)
        if code is None or not code.co_filename.replace('\\', '/').endswith(suffix):
            raise ImportError('Not the installed error logging dependency: ' + name)
        return code

    def definition(code, name):
        matches = [value for value in code.co_consts if type(value) is types.CodeType and value.co_name == name]
        if len(matches) != 1:
            raise ImportError('Ambiguous installed error logging definition: ' + name)
        return matches[0]

    if type(arguments) is not list or not arguments or any(type(arg) is not unicode for arg in arguments):
        raise TypeError('Actual companion startup arguments must be a nonempty Unicode list')
    startup_args = tuple(arguments)
    startup_map = {}
    # Source-backed companion input port: BlueOS.SetStartupArgs2080+, skip argv0,
    # remove ONE slash, split FIRST '=', case-sensitive names. Real host inputs,
    # not empty/always-false flags or ExeFile/@ expansion/BlueOS construction.
    for arg in startup_args[1:]:
        name = arg[1:] if arg.startswith(u'/') else arg
        name, separator, value = name.partition(u'=')
        startup_map[name] = value

    def get_args():
        # BluePython.PyGetArg1544 returns a fresh Unicode list. The append/slice
        # also copies native Unicode contents without changing surrogate units.
        return [(arg + u'\0')[:-1] for arg in startup_args]

    def has_argument(name):
        return name in startup_map

    startup = types.ModuleType('companion.log_startup_inputs')
    startup.arguments, startup.map = startup_args, startup_map
    startup.GetArg, startup.HasStartupArg = get_args, has_argument
    pyos = types.ModuleType('companion.error_pyos_inputs')
    pyos.taskletTimer, pyos.GetArg = tasklet_timer, get_args
    os_inputs = types.ModuleType('companion.error_os_inputs')
    os_inputs.HasStartupArg = has_argument
    blue_inputs = types.ModuleType('companion.error_blue_inputs')
    blue_inputs.pyos, blue_inputs.os = pyos, os_inputs

    bunch_module = types.ModuleType('carbonui.util.bunch')
    bunch_module.__dict__['__builtins__'] = __builtin__.__dict__
    types.FunctionType(module_code('carbonui.util.bunch', '/packages/carbonui/util/bunch.py'), bunch_module.__dict__)()
    # Actual SettingsSvc.LoadSettings prefix creates Bunch before section load.
    # Do not invent/alias public.generic as top-level generic or claim files,
    # YAML, autotimers, settings services or browser dialog initialization.
    if hasattr(context.builtins, 'settings'):
        raise RuntimeError('Existing settings namespace needs its actual source owner')
    settings = bunch_module.Bunch()
    context.builtins.settings = settings

    # Execute the complete original exception package once for this client.
    # Its subclasses and later appConst consumers must share this SAME UserError,
    # rather than materializing another selected class with a different identity.
    exceptions = _create_original_module_graph({
        'eveexceptions': '/packages/eveexceptions/__init__.py',
        'eveexceptions.const': '/packages/eveexceptions/const.py',
        'eveexceptions.exceptionEater': '/packages/eveexceptions/exceptionEater.py',
    }, {'__builtin__': context.builtins,
        'logging': stdlogutils.__dict__['_CLIENT_IMPORT_BINDINGS']['logging']})
    exception_package = exceptions.load('eveexceptions')
    exceptions.complete = True
    user_error = exception_package.UserError

    namespace = logmodule.__dict__
    namespace.update({'__builtins__': __builtin__.__dict__, '__builtin__': context.builtins,
                      '_CLIENT_IMPORT_BINDINGS': dict(stdlogutils.__dict__['_CLIENT_IMPORT_BINDINGS']),
                      'blue': blue_inputs, 'localstorage': context.localstorage,
                      'session': context.session, 'settings': settings,
                      'sys': sys, 'datetime': datetime, 'traceback2': traceback2,
                      'StringIO': cStringIO.StringIO, 'UserError': user_error,
                      'GetStack': stdlogutils.GetStack, 'NextTraceID': stdlogutils.NextTraceID,
                      'DATETIME_FORMAT_STR': '%m/%d/%Y %H:%M:%S', '_WIN_EBADF': 9,
                      'logExceptionLevel': 0, 'sentry_client': None, 'postStackTraceAll': None})
    namespace['_CLIENT_IMPORT_BINDINGS'].update({'blue': blue_inputs, 'localstorage': context.localstorage, 'logmodule': logmodule})
    source = module_code('logmodule', '/packages/logmodule/__init__.py')
    for name in ('Multiplex', 'MsgWindowStream', 'LogAlertServiceStream'):
        namespace[name] = type(name, (object,), types.FunctionType(definition(source, name), namespace)())
    for name in ('GetMultiplex', '_LogThreadLocals', 'MsgWindowStreamToMsgWindow', '_LogException',
                 'LogException', 'LogTraceback', 'DumpMemoryStatus', 'DumpMemHistory'):
        defaults = None
        if name == 'LogException':
            defaults = ('', 'general', 1, 1, None, 1, None, None, None, None, 1)
        elif name == 'LogTraceback':
            defaults = ('', 'general', 1, None, 1, 0, None, logmodule.LGERR, 1, None)
        namespace[name] = types.FunctionType(definition(source, name), namespace, name, defaults)

    def assert_profile():
        context.assert_entry()
        if hasattr(context.builtins, 'sm') or settings.has_key('generic'):
            raise RuntimeError('Active settings/service-manager logging needs its real loaded providers')
        if logmodule.MsgWindowStreamToMsgWindow():
            raise RuntimeError('Enabled exception popups require a real scheduler/UI producer')

    assert_profile()
    logger = types.ModuleType('localization.logger')
    logger.__dict__.update({'__builtins__': __builtin__.__dict__, '__package__': '',
                            '_CLIENT_IMPORT_BINDINGS': namespace['_CLIENT_IMPORT_BINDINGS']})
    types.FunctionType(module_code('localization.logger', '/packages/localization/logger.py'), logger.__dict__)()
    result = types.ModuleType('companion.error_logging_owner')
    result.logmodule, result.localization_logger, result.UserError = logmodule, logger, user_error
    result.exceptions, result.exceptions_owner = exception_package, exceptions
    # The log module is already the shared error consumer passed to rowsets.
    logmodule._client_exceptions_owner = exceptions
    result.settings, result.startup, result.blue = settings, startup, blue_inputs
    result.assert_profile, result.context, result.stdlogutils = assert_profile, context, stdlogutils

    def traceback_entry(*args):
        # A genuine companion entry frame for original extract_stack(up=1).
        # The installed function and its defaults/caller traversal stay intact.
        assert_profile()
        return logmodule.LogTraceback(*args)

    def exception_entry(*args):
        assert_profile()
        return logmodule.LogException(*args)

    result.traceback_entry, result.exception_entry = traceback_entry, exception_entry
    return result


def _attach_localization_lookup(settings_owner, data, standard_logging, logmodule, logger, context, startup):
    # Named lookup/data phase on the SAME settings instance; not its full
    # Localization constructor/LoadLanguageData, property handlers or Blue engine.
    import types, __builtin__, os, dis, re
    context.assert_entry()
    if context.preferences is not settings_owner.preferences or context.boot is not settings_owner.boot:
        raise ValueError('Localization must retain the actual early settings/session owners')

    def code_for(name, suffix):
        prefix = name.rpartition('.')[0].replace('.', '/')
        importer = zipimport.zipimporter(_archive + ('/' + prefix if prefix else ''))
        code = importer.get_code(name)
        if code is None or not code.co_filename.replace('\\', '/').endswith(suffix):
            raise ImportError('Not the installed localization lookup dependency: ' + name)
        return importer, code

    def definition(code, name):
        matches = [v for v in code.co_consts if type(v) is types.CodeType and v.co_name == name]
        if len(matches) != 1:
            raise ImportError('Ambiguous installed lookup definition: ' + name)
        return matches[0]

    def instructions(code):
        result, cursor = [], 0
        while cursor < len(code.co_code):
            opcode = ord(code.co_code[cursor])
            cursor += 1
            argument = None
            if opcode >= dis.HAVE_ARGUMENT:
                argument = ord(code.co_code[cursor]) | ord(code.co_code[cursor + 1]) << 8
                cursor += 2
            if opcode == dis.EXTENDED_ARG:
                raise ImportError('Unsupported lookup literal instruction')
            result.append((dis.opname[opcode], argument))
        return result

    def literal(code, name):
        rows = instructions(code)
        stores = [i for i, (op, arg) in enumerate(rows) if op == 'STORE_NAME' and code.co_names[arg] == name]
        if len(stores) != 1 or rows[stores[0] - 1][0] != 'LOAD_CONST':
            raise ImportError('Not a closed lookup literal: ' + name)
        return code.co_consts[rows[stores[0] - 1][1]]

    # Fresh BluePyOS policy bool is source/shipped false; its Startup enables
    # by argument PRESENCE, not value. This is a selected companion policy port
    # over real captured host inputs, NOT a native getter or ExeFile invocation.
    policy = types.ModuleType('companion.fresh_localization_telemetry_policy')
    policy.markupZonesInPython = False
    if startup.HasStartupArg('telemetryMarkup'):
        policy.markupZonesInPython = True
    if policy.markupZonesInPython:
        raise RuntimeError('Telemetry markup requires a real statistics zone producer')
    blue_policy = types.ModuleType('companion.localization_policy_inputs')
    blue_policy.pyos = policy
    owned_prefs = types.ModuleType('eveprefs')
    owned_prefs.boot, owned_prefs.prefs = context.boot, settings_owner.preferences
    bindings = {'logging': standard_logging, 'eveprefs': owned_prefs, '__builtin__': context.builtins,
                'localstorage': context.localstorage, 'blue': blue_policy}
    for name in ('operator', 'contextlib', 'functools', 'types'):
        bindings[name] = _client_import_fallback(name, globals(), locals(), (), 0)

    def shell(name, suffix):
        importer, code = code_for(name, suffix)
        module = types.ModuleType(name)
        filename, package = importer.get_filename(name), importer.is_package(name)
        module.__file__, module.__loader__ = filename, importer
        module.__package__ = name if package else name.rpartition('.')[0]
        if package:
            module.__path__ = [os.path.dirname(filename)]
        module.__dict__.update({'__builtins__': __builtin__.__dict__, '_CLIENT_IMPORT_BINDINGS': bindings,
                                'session': context.session})
        return module, code

    langutils, root_code = shell('langutils', '/packages/langutils/__init__.py')
    bindings['langutils'] = langutils
    modules = []
    for name in ('comfylang', 'langconst', 'logic'):
        module, code = shell('langutils.' + name, '/packages/langutils/' + name + '.py')
        setattr(langutils, name, module)
        bindings[name], bindings['langutils.' + name] = module, module
        modules.append((module, code))
    langutils.__dict__['_CLIENT_RELATIVE_IMPORT_BINDINGS'] = {name: getattr(langutils, name) for name in ('comfylang', 'langconst', 'logic')}
    for module, code in modules:
        types.FunctionType(code, module.__dict__)()
    types.FunctionType(root_code, langutils.__dict__)()
    zoning, zoning_code = shell('pytelemetry.zoning', '/packages/pytelemetry/zoning.py')
    types.FunctionType(zoning_code, zoning.__dict__)()
    settings_package = types.ModuleType('localization.settings')
    settings_package.qaSettings, settings_package.bilingualSettings = settings_owner.qa, settings_owner.bilingual
    uiutil = types.ModuleType('localization.uiutil')
    uiutil.__dict__.update({'__builtins__': __builtin__.__dict__, 'settings': settings_package})
    _, ui_code = code_for('localization.uiutil', '/packages/localization/uiutil.py')
    uiutil.PrepareLocalizationSafeString = types.FunctionType(definition(ui_code, 'PrepareLocalizationSafeString'), uiutil.__dict__, 'PrepareLocalizationSafeString', (None,))
    _, source = code_for('localization.localizationBase', '/packages/localization/localizationBase.py')
    cls = definition(source, 'Localization')
    # Recover the actual eight Unicode strings from the closed original dict
    # expression; never use the corrupted non-English decompiler rendering.
    rows = instructions(source)
    stores = [i for i, (op, arg) in enumerate(rows) if op == 'STORE_NAME' and source.co_names[arg] == 'FALLBACK_TRANSLATION_STRINGS']
    if len(stores) != 1:
        raise ImportError('Ambiguous original fallback dictionary')
    end = stores[0]
    start = max(i for i, (op, arg) in enumerate(rows[:end]) if op == 'BUILD_MAP')
    stack = []
    for op, arg in rows[start:end]:
        if op == 'BUILD_MAP' and not stack:
            stack.append({})
        elif op == 'LOAD_CONST':
            stack.append(source.co_consts[arg])
        elif op == 'STORE_MAP' and len(stack) == 3 and type(stack[0]) is dict:
            key, value = stack.pop(), stack.pop()
            stack[0][key] = value
        else:
            raise ImportError('Fallback dictionary is not a closed constant expression')
    if len(stack) != 1 or type(stack[0]) is not dict or len(stack[0]) != 8:
        raise ImportError('Unexpected original fallback dictionary')
    _, common = code_for('localization.common.util', '/packages/localization/common/util.py')
    constants, constants_code = shell('carbon.common.script.sys.serviceConst', '/carbon/common/script/sys/serviceConst.py')
    types.FunctionType(constants_code, constants.__dict__)()
    namespace = {'__name__': 'localization.localizationBase', '__builtins__': __builtin__.__dict__,
                 '_CLIENT_IMPORT_BINDINGS': bindings, 'session': context.session,
                 'boot': context.boot, 'prefs': settings_owner.preferences, 'langutils': langutils,
                 'internalUtil': settings_owner.internal, 'qaSettings': settings_owner.qa,
                 'bilingualSettings': settings_owner.bilingual, 'commonutils': settings_owner.commonutils,
                 'locconst': settings_owner.constants, 'UNRESOLVED_LOC_MARKER': literal(common, 'UNRESOLVED_LOC_MARKER'),
                 'FALLBACK_TRANSLATION_STRINGS': stack[0], 'ROLEMASK_ELEVATEDPLAYER': constants.ROLEMASK_ELEVATEDPLAYER,
                 'logger': logger, 'logmodule': logmodule, 'log': standard_logging.getLogger('localization.localizationBase'),
                 'eveLocalization': data.backend, 'uiutil': uiutil, 're': re, 'sys': sys}
    selected, decorated = settings_owner.settings, []
    if hasattr(selected, 'languageLabels'):
        raise RuntimeError('An attached localization lookup cannot be initialized again')
    for name in ('_InitializeInternalVariables', '_InitializeTextData', '_ReadMainLocalizationData', '_IsValidLanguage',
                 'SetFallBackMode', 'GetFallBackMode', 'Get', 'GetByMessageID', 'GetByLabel',
                 'GetImportantByMessageID', 'GetImportantByLabel', 'GetMessageIDForLabel', 'GetLanguages',
                 'UsePrimaryLanguageText', 'HighlightImportant', 'UseImportantTooltip', '_QaTooltipOverride',
                 'FormatImportantString', 'CleanImportantMarkup'):
        defaults = (None,) if name in ('Get', 'GetByMessageID', 'GetByLabel') else None
        method = types.FunctionType(definition(cls, name), namespace, name, defaults)
        if name in ('_InitializeTextData', '_ReadMainLocalizationData', 'UsePrimaryLanguageText'):
            method = zoning.ZONE_METHOD(method)
            decorated.append(name)
        setattr(type(selected), name, method)
    for name in ('FIELD_LABELS', 'FIELD_LANGUAGES', 'FIELD_TYPES'):
        setattr(type(selected), name, literal(cls, name))
    selected._InitializeInternalVariables()
    selected._InitializeTextData()
    selected.SetFallBackMode(0)
    supported = selected._ReadMainLocalizationData(data.main, settings_owner.constants.DATATYPE_FSD)
    if not supported or not data.backend.HasLanguage(selected._GetPrimaryLanguage()):
        raise RuntimeError('Original main label data or actual primary language is unavailable')
    selected._primaryLanguageID = data.backend.GetPrimaryLanguage()
    if selected._primaryLanguageID != selected._GetPrimaryLanguage():
        raise RuntimeError('Loaded backend and original primary-language constant differ')
    selected._GetByMessageID = data.backend.GetMessageByID
    result = types.ModuleType('companion.localization_lookup_owner')
    result.settings, result.data, result.context = settings_owner, data, context
    result.instance, result.langutils, result.uiutil = selected, langutils, uiutil
    result.policy, result.zoning, result.decorated = policy, zoning, tuple(decorated)
    result.namespace = namespace

    def invoke(name, args, kwargs):
        return getattr(selected, name)(*args, **kwargs)

    result.invoke = invoke
    def entry(name):
        def call(*args):
            # A real companion caller for source Get's exception-frame locals.
            return getattr(selected, name)(*args)
        return call
    result.entries = {name: entry(name) for name in ('Get', 'GetByMessageID', 'GetByLabel', 'GetImportantByMessageID', 'GetImportantByLabel')}
    return result


def _attach_static_load(service_types, data, evetypes, raw_groups, raw_categories, lookup, timer_module, constant_values):
    # Extend the SAME class/data/type/cache owners. Full original Load is
    # available separately from Run, weak monitors and ServiceManager readiness.
    import types, __builtin__, dis, re
    from collections import defaultdict
    from caching.memoize import Memoize

    def module_code(name, suffix):
        prefix = name.rpartition('.')[0].replace('.', '/')
        code = zipimport.zipimporter(_archive + ('/' + prefix if prefix else '')).get_code(name)
        if code is None or not code.co_filename.replace('\\', '/').endswith(suffix):
            raise ImportError('Not the installed static Load dependency: ' + name)
        return code

    def definition(code, name):
        found = [v for v in code.co_consts if type(v) is types.CodeType and v.co_name == name]
        if len(found) != 1:
            raise ImportError('Ambiguous installed static Load definition: ' + name)
        return found[0]

    def instructions(code):
        rows, cursor = [], 0
        while cursor < len(code.co_code):
            op = ord(code.co_code[cursor])
            cursor += 1
            arg = None
            if op >= dis.HAVE_ARGUMENT:
                arg = ord(code.co_code[cursor]) | ord(code.co_code[cursor + 1]) << 8
                cursor += 2
            if op == dis.EXTENDED_ARG:
                raise ImportError('Unsupported static Load literal instruction')
            rows.append((dis.opname[op], arg))
        return rows

    base = service_types.BaseDogmaStaticSvc
    namespace = base.__dict__['__init__'].func_globals
    if namespace['dogma_data'] is not data or namespace['evetypes'] is not evetypes:
        raise ValueError('Static Load must retain the same phase/type/data owners')
    lookup.context.assert_entry()
    if lookup.policy.markupZonesInPython:
        raise RuntimeError('Static localization needs its real telemetry zone producer')
    const = namespace['const']
    for name, value in constant_values.iteritems():
        setattr(const, name, value)
    types_data = evetypes.data
    loader = types_data.Types.__bases__[0]
    source = module_code('evetypes.data', '/packages/evetypes/data.py')
    for name, extension, raw in (('Groups', 'groupsLoader', raw_groups), ('Categories', 'categoriesLoader', raw_categories)):
        types_data.__dict__[extension] = sys.modules[extension]
        cls = type(name, (loader,), types.FunctionType(definition(source, name), types_data.__dict__)())
        cls.__binary__ = raw
        setattr(types_data, name, cls)
        setattr(evetypes, name, cls)
    type_globals = evetypes.__dict__
    type_globals['defaultdict'] = defaultdict
    source = module_code('evetypes', '/packages/evetypes/__init__.py')
    for name in ('GroupNotFoundException', 'CategoryNotFoundException', 'GroupAttributeNotFoundException', 'CategoryAttributeNotFoundException'):
        type_globals[name] = type(name, (Exception,), types.FunctionType(definition(source, name), type_globals)())
    localization = types.ModuleType('companion.original_localization_api')
    for name in ('GetByMessageID', 'GetImportantByMessageID', 'CleanImportantMarkup'):
        setattr(localization, name, getattr(lookup.instance, name))
    owned_prefs = types.ModuleType('eveprefs')
    owned_prefs.boot, owned_prefs.prefs = lookup.settings.boot, lookup.settings.preferences
    # Use the actual per-client standard logging module, never a shared root.
    bindings = {'logging': lookup.langutils.comfylang.logging,
                'eveprefs': owned_prefs, 'localization': localization}
    localized = types.ModuleType('evetypes.localizationUtils')
    localized.__dict__.update({'__builtins__': __builtin__.__dict__, '__package__': '', '_CLIENT_IMPORT_BINDINGS': bindings})
    types.FunctionType(module_code('evetypes.localizationUtils', '/packages/evetypes/localizationUtils.py'), localized.__dict__)()
    for name in ('GetLocalizedGroupName', 'GetLocalizedCategoryName'):
        type_globals[name] = getattr(localized, name)
    for name in ('GetGroups', 'GetCategories', 'GetGroup', 'GetCategory', '_GetAttributeForGroup', '_GetAttributeForCategory',
                 'GetGroupID', 'GetCategoryID', 'GetCategoryIDByGroup', 'GetGroupNameIDByGroup',
                 'GetGroupNameByGroup', 'GetCategoryNameByCategory', 'GetCategoryNameIDByCategory',
                 '_GetTypeIDsByGroupID', 'GetTypeIDsByGroup', '_GetGroupIDsByCategoryID', 'GetGroupIDsByCategory'):
        defaults = (None, True) if name in ('GetGroupNameByGroup', 'GetCategoryNameByCategory') else None
        type_globals[name] = types.FunctionType(definition(source, name), type_globals, name, defaults)
    source = module_code('dogma.data', '/packages/dogma/data.py')
    rows = instructions(source)
    stores = [i for i, (op, arg) in enumerate(rows) if op == 'STORE_NAME' and source.co_names[arg] == 'charge_group_regex']
    if len(stores) != 1:
        raise ImportError('Ambiguous original charge regex')
    end = stores[0]
    prefix = rows[end - 4:end]
    if len(prefix) != 4 or [op for op, arg in prefix] != ['LOAD_NAME', 'LOAD_ATTR', 'LOAD_CONST', 'CALL_FUNCTION'] or source.co_names[prefix[0][1]] != 're' or source.co_names[prefix[1][1]] != 'compile' or prefix[3][1] != 1:
        raise ImportError('Charge regex is not the original closed compile expression')
    data.charge_group_regex = re.compile(source.co_consts[prefix[2][1]])
    for name in ('get_charge_group_attributes', 'get_charge_group_attribute_ids'):
        setattr(data, name, Memoize(types.FunctionType(definition(source, name), data.__dict__)))
    cfg_code = definition(module_code('eve.common.script.sys.eveCfg', '/eve/common/script/sys/eveCfg.py'), 'EveConfig')
    init = definition(cfg_code, '__init__')
    rows = instructions(init)
    stores = [i for i, (op, arg) in enumerate(rows) if op == 'STORE_ATTR' and init.co_names[arg] == 'crystalgroups']
    if len(stores) != 1 or rows[stores[0] - 2:stores[0]] != [('BUILD_LIST', 0), ('LOAD_FAST', 0)]:
        raise ImportError('Crystal cache is not the original fresh empty-list field')
    cfg_globals = {'__name__': 'eve.common.script.sys.eveCfg', '__builtins__': __builtin__.__dict__,
                   'evetypes': evetypes, 'const': const, 'localization': localization}
    cfg = type('ClientCrystalConfigFields', (object,), {
        '__module__': 'companion.crystal_config_fields',
        'GetCrystalGroups': types.FunctionType(definition(cfg_code, 'GetCrystalGroups'), cfg_globals)})()
    cfg.crystalgroups = []  # Proven constructor literal above; no constructor slice/full Cfg claim.
    namespace.update({'cfg': cfg, 'bluepy': timer_module})
    source = definition(module_code('eve.common.script.dogma.baseDogmaStaticSvc', '/eve/common/script/dogma/baseDogmaStaticSvc.py'), 'BaseDogmaStaticSvc')
    base.Load = types.FunctionType(definition(source, 'Load'), namespace)
    result = types.ModuleType('companion.static_load_owner')
    result.cfg, result.evetypes, result.data, result.localization, result.localized = cfg, evetypes, data, lookup, localized
    result.timer, result.types = timer_module, service_types

    def load(instance):
        if not isinstance(instance, service_types.ClientDogmaStaticSvc):
            raise TypeError('Load instance belongs to another static owner')
        return instance.Load()

    result.load = load
    return result


def _attach_static_run(full_load, logging, helpers, context, logmodule):
    # Original Run/weak callbacks over the existing owner. Snapshot adoption
    # below is explicitly local; it is NOT ReloadDataFromDisk or a disk watcher.
    import types, __builtin__, inspect, weakref
    if full_load.localization.context is not context or full_load.localization.langutils.comfylang.logging is not logging:
        raise ValueError('Static Run must retain the same current-session/logging owners')

    def assert_profile():
        context.assert_entry()
        # ORIGINAL Sissy over real private storage, not a hardcoded None or a
        # fabricated LogSessionHistory. The effective field phase never ran
        # __ChangeAttribute's character-history publication/clock lifecycle.
        if context.builtins.charsession:
            raise RuntimeError('Character history logging needs its real Session producer')

    assert_profile()

    def module_code(name, suffix):
        prefix = name.rpartition('.')[0].replace('.', '/')
        importer = zipimport.zipimporter(_archive + ('/' + prefix if prefix else ''))
        code = importer.get_code(name)
        if code is None or not code.co_filename.replace('\\', '/').endswith(suffix):
            raise ImportError('Not the installed static Run dependency: ' + name)
        return importer, code

    def definition(code, name):
        found = [v for v in code.co_consts if type(v) is types.CodeType and v.co_name == name]
        if len(found) != 1:
            raise ImportError('Ambiguous installed static Run definition: ' + name)
        return found[0]

    # Application modules are private to the real per-client logging owner.
    # Reusing its utility modules avoids duplicate NullHandlers/class identities
    # if another static-service owner is explicitly constructed on that client.
    if not hasattr(logging, '_companion_static_run_modules'):
        logging._companion_static_run_modules = {}
    modules = logging._companion_static_run_modules
    bindings = dict(helpers.__dict__['_CLIENT_IMPORT_BINDINGS'])
    bindings.update({'logging': logging, 'logmodule': logmodule, 'stdlogutils': helpers,
                     '__builtin__': context.builtins, 'inspect': inspect, 'sys': sys, 'weakref': weakref})

    def original_module(name, suffix):
        if name in modules:
            previous = modules[name]
            if previous['error'] is not None:
                raise previous['error'][0], previous['error'][1], previous['error'][2]
            if not previous['complete']:
                raise ImportError('An owned utility module is still initializing: ' + name)
            return previous['module']
        importer, code = module_code(name, suffix)
        module = types.ModuleType(name)
        module.__file__, module.__loader__, module.__package__ = importer.get_filename(name), importer, ''
        module.__dict__.update({'__builtins__': __builtin__.__dict__, '_CLIENT_IMPORT_BINDINGS': bindings})
        slot = {'module': module, 'complete': False, 'error': None}
        modules[name] = slot
        try:
            types.FunctionType(code, module.__dict__)()
        except BaseException:
            slot['error'] = sys.exc_info()  # Preserve the actual failed prefix.
            raise
        slot['complete'] = True
        return module

    signal = original_module('signals.signal', '/packages/signals/signal.py')
    # logUtil's actual dotted import returns the root package for an empty
    # fromlist. Execute the four original package initializers and pure export
    # helper, then retain their real hierarchy rather than inventing exports.
    parent = None
    for name in ('carbon', 'carbon.common', 'carbon.common.script', 'carbon.common.script.util'):
        package = original_module(name, '/' + name.replace('.', '/') + '/__init__.py')
        if parent is not None:
            setattr(parent, name.rsplit('.', 1)[1], package)
        parent = package
    parent.autoexport = original_module('carbon.common.script.util.autoexport', '/carbon/common/script/util/autoexport.py')
    bindings['carbon.common.script.util.autoexport'] = modules['carbon']['module']
    log_util = original_module('carbon.common.script.util.logUtil', '/carbon/common/script/util/logUtil.py')
    core = full_load.types.CoreService
    core_globals = core.__dict__['__init__'].func_globals
    core_globals.update({'charsession': context.builtins.charsession, 'boot': context.boot, 'sys': sys,
                         'supersafestr': log_util.supersafestr, 'LineWrap': helpers.LineWrap})
    _, source = module_code('carbon.common.script.sys.service', '/carbon/common/script/sys/service.py')
    source = definition(source, 'CoreService')
    for name in ('LogError', 'LogInfo'):
        setattr(core, name, types.FunctionType(definition(source, name), core_globals))
    data = full_load.data
    data.logger = logging.getLogger('dogma.data')
    _, source = module_code('dogma.data', '/packages/dogma/data.py')
    data.refresh_dogma = types.FunctionType(definition(source, 'refresh_dogma'), data.__dict__)
    loader = data.DogmaAttributes.__bases__[0]
    loader.ConnectToOnReload.im_func.func_globals['Signal'] = signal.Signal
    base = full_load.types.BaseDogmaStaticSvc
    namespace = base.__dict__['__init__'].func_globals
    _, source = module_code('eve.common.script.dogma.baseDogmaStaticSvc', '/eve/common/script/dogma/baseDogmaStaticSvc.py')
    source = definition(source, 'BaseDogmaStaticSvc')
    for name in ('Run', '_MonitorStaticDataChanges', '_ReloadDogmaData'):
        setattr(base, name, types.FunctionType(definition(source, name), namespace))
    loaders = {name: getattr(data, name) for name in ('DogmaAttributes', 'DogmaEffects', 'TypeDogma')}

    def run(instance, *args):
        assert_profile()
        if not isinstance(instance, full_load.types.ClientDogmaStaticSvc):
            raise TypeError('Run instance belongs to another static owner')
        return instance.Run(*args)

    def emit(name):
        assert_profile()
        cls = loaders[name]
        if cls.onReload:
            cls.onReload()

    def adopt_snapshot(name, raw):
        assert_profile()
        cls = loaders[name]
        if type(raw) is not type(cls.__binary__):
            raise TypeError('Snapshot must be the same actual native loader data type')
        cls.__binary__ = raw
        # Re-read current source signal AFTER publication; preserve all partial
        # fields and the new binary if callbacks or their logger raise.
        if cls.onReload:
            cls.onReload()

    result = types.ModuleType('companion.static_run_owner')
    result.full_load, result.context, result.signal = full_load, context, signal
    result.log_util, result.loaders = log_util, loaders
    result.assert_profile, result.run, result.emit, result.adopt_snapshot = assert_profile, run, emit, adopt_snapshot
    return result


def _create_row_descriptor_protocol():
    # Explicit companion SOURCE PORT over the C layout, never a Blue heap type
    # or fake entry in sys.modules['blue']. Types/pure getters are VM-wide;
    # each descriptor owns its columns/virtual references on the Python heap.
    import types
    existing = globals().get('_companion_descriptor_protocol')
    if existing is not None:
        if existing.error is not None:
            raise existing.error[0], existing.error[1], existing.error[2]
        if not existing.complete:
            raise ImportError('Descriptor protocol initialization is incomplete')
        return existing
    module = types.ModuleType('companion.row_descriptor')
    module.complete, module.error = False, None
    globals()['_companion_descriptor_protocol'] = module
    try:
        class DescriptorDomainError(RuntimeError):
            pass

        class CompanionRowDescriptor(object):
            __slots__ = ('_columns', '_storage', '_virtual', '_setting', '_unsafe', '_wire_owner', '_wire_provenance')
            __module__ = module.__name__
            _domain_error = DescriptorDomainError

            def __init__(self, *args, **ignored_keywords):
                # The shipped C constructor ignores its keyword dict; its
                # positional argument parser and tuple layout stay native.
                layout = _client_prefs_io.row_descriptor_layout(*args)
                self._columns, self._storage = layout[0], layout[1:]
                self._virtual, self._setting, self._unsafe = None, False, False
                self._wire_owner, self._wire_provenance = None, None

            def _rebuild(self):
                layout = _client_prefs_io.row_descriptor_layout(tuple((c[0], c[1]) for c in self._columns))
                self._columns, self._storage = layout[0], layout[1:]

            def __len__(self):
                return len(self._columns)

            def __getitem__(self, index):
                # Canonical builtin-integer bracket domain only. A Python
                # wrapper cannot reproduce BOTH distinct native sq_item and
                # method-wrapper diagnostics for arbitrary objects/slices.
                if not isinstance(index, (int, long)):
                    raise DescriptorDomainError('Descriptor index needs a builtin integer')
                return _client_prefs_io.row_descriptor_method(self, 3)(index)

            @property
            def Keys(self):
                return _client_prefs_io.row_descriptor_method(self, 0)

            @property
            def Index(self):
                if self._setting:
                    self._unsafe = True
                    raise DescriptorDomainError('Reentrant native column-map access is outside this capability')
                return _client_prefs_io.row_descriptor_method(self, 1)

            @property
            def Size(self):
                return _client_prefs_io.row_descriptor_method(self, 2)

            def __repr__(self):
                return '<DBRowDescriptor object %s %d>' % (repr(list(self)), self._storage[2])

            def __eq__(self, other):
                if type(other) is not type(self):
                    return NotImplemented
                return self._columns == other._columns

            def __ne__(self, other):
                result = self.__eq__(other)
                return NotImplemented if result is NotImplemented else not result

            def __cmp__(self, other):
                if type(other) is type(self) and self._columns == other._columns:
                    return 0
                raise DescriptorDomainError('Native descriptor pointer ordering is outside this capability')

            def __hash__(self):
                raise DescriptorDomainError('Native descriptor pointer hashing is outside this capability')

            @property
            def virtual(self):
                return [] if self._virtual is None else list(self._virtual)

            @virtual.setter
            def virtual(self, value):
                if self._setting or self._unsafe:
                    self._unsafe = True
                    raise DescriptorDomainError('Unsafe native virtual-setter continuation is outside this capability')
                if not isinstance(value, list):
                    raise TypeError('list required')
                old = self._columns
                old_length = 0 if self._virtual is None else len(self._virtual)
                basic = len(old) - old_length
                if basic < 0:
                    raise DescriptorDomainError('Native virtual backing exceeds current columns')
                count, collected = list.__len__(value), []
                self._setting = True
                self._columns = old[:basic]
                try:
                    for i in xrange(count):
                        if list.__len__(value) < count:
                            self._unsafe = True
                            raise DescriptorDomainError('Input shrink during native virtual conversion is outside this capability')
                        entry = list.__getitem__(value, i)
                        if not isinstance(entry, tuple) or tuple.__len__(entry) != 2:
                            self._columns = old
                            self._rebuild()
                            raise TypeError('expected list of tuples of size two')
                        try:
                            name = str(tuple.__getitem__(entry, 0))
                        except BaseException:
                            self._columns = old
                            self._rebuild()
                            raise
                        if list.__len__(value) < count:
                            self._unsafe = True
                        if self._unsafe:
                            raise DescriptorDomainError('Unsafe native virtual-setter continuation is outside this capability')
                        # PyObject_Str followed by std::string(char*) in the
                        # shipped setter, distinct from constructor 's' parse.
                        name = str.split(name, '\x00', 1)[0]
                        self._columns += ((name, 0, 0, 0),)
                        try:
                            collected.append(entry)  # SAME tuple/getter objects.
                        except BaseException:
                            self._columns = old
                            self._rebuild()
                            raise
                    self._rebuild()
                    if count:
                        self._virtual = collected
                    elif old_length:
                        # Preserve the observed stale backing after []. Never
                        # pretend a later unsafe subtraction is a normal set.
                        self._unsafe = True
                finally:
                    self._setting = False

            def __getstate__(self):
                return self.virtual

            def __setstate__(self, value):
                self.virtual = value

        def code_for(name, suffix):
            prefix = name.rpartition('.')[0].replace('.', '/')
            code = zipimport.zipimporter(_archive + ('/' + prefix if prefix else '')).get_code(name)
            if code is None or not code.co_filename.replace('\\', '/').endswith(suffix):
                raise ImportError('Not the installed descriptor dependency: ' + name)
            return code

        # Execute the actual constant module. Its source import/pyos branch is
        # evaluated against the real current host; no fabricated ix values.
        constants = types.ModuleType('companion.descriptor_constants')
        constants.__dict__['__builtins__'] = __builtins__
        types.FunctionType(code_for('carbon.common.lib.const', '/carbon/common/lib/const.py'), constants.__dict__)()
        source = code_for('eve.common.script.sys.eveCfg', '/eve/common/script/sys/eveCfg.py')
        namespace = {'__name__': 'eve.common.script.sys.eveCfg', '__file__': source.co_filename,
                     '__builtins__': __builtins__, 'const': constants}
        for name in ('StackSize', 'Singleton'):
            matches = [v for v in source.co_consts if type(v) is types.CodeType and v.co_name == name]
            if len(matches) != 1:
                raise ImportError('Ambiguous original descriptor getter: ' + name)
            setattr(module, name, types.FunctionType(matches[0], namespace))
        module.Descriptor, module.DomainError, module.constants = CompanionRowDescriptor, DescriptorDomainError, constants
        module.complete = True
    except BaseException:
        module.error = sys.exc_info()
        raise
    return module


def _create_row_protocol(protocol):
    # Named source port of CCP PyRowSet.cpp and shipped Python2 slots. This is
    # not the Blue heap type, its raw serializer, allocator or pointer hash.
    import types
    existing = globals().get('_companion_row_protocol')
    if existing is not None:
        if existing.descriptors is not protocol:
            raise TypeError('Rows require the same VM descriptor protocol')
        return existing
    if protocol is not _create_row_descriptor_protocol():
        raise TypeError('Rows require the actual named descriptor protocol')
    io, raw_get, raw_set = _client_prefs_io, object.__getattribute__, object.__setattr__
    Descriptor, DomainError = protocol.Descriptor, protocol.DomainError

    def header(row):
        return raw_get(row, '_row_header')

    def stable(row, descriptor, columns):
        if header(row) is not descriptor or descriptor._columns is not columns or descriptor._unsafe:
            raise DomainError('Header mutation during a row operation is outside this capability')

    def get(row, index):
        descriptor = header(row)
        io.row_index(descriptor, index)  # Also enforces the descriptor domain.
        columns = descriptor._columns
        column = descriptor._columns[index]
        if column[1] == 0:
            virtual = descriptor._virtual
            if virtual is None:
                raise RuntimeError('Internal error in VirtualGet; no mVirtualGetSet.')
            if not isinstance(virtual, list):
                raise RuntimeError("Internal error in VirtualGet;  mVirtualGetSet.o isn't a list.")
            offset = column[3]
            if offset < 0 or offset >= list.__len__(virtual):
                raise RuntimeError('Internal error in VirtualGet; GetSet list has funky size.')
            pair = list.__getitem__(virtual, offset)
            if not isinstance(pair, tuple) or tuple.__len__(pair) < 2:
                raise RuntimeError('Internal error in VirtualGet; Virtual column wrongly specified.')
            result = tuple.__getitem__(pair, 1)(row)
            stable(row, descriptor, columns)
            return result
        initialized = raw_get(row, '_row_initializing')
        if initialized is not None and index not in initialized:
            raise DomainError('Reading uninitialized native row memory is outside this capability')
        return io.row_get(descriptor, raw_get(row, '_row_bytes'), raw_get(row, '_row_objects'), index)

    def put(row, index, value):
        descriptor = header(row)
        columns = descriptor._columns
        io.row_set(descriptor, raw_get(row, '_row_bytes'), raw_get(row, '_row_objects'), index, value)
        stable(row, descriptor, columns)
        initialized = raw_get(row, '_row_initializing')
        if initialized is not None:
            initialized.add(index)

    def interval(row, low, high):
        count = len(header(row))
        low = min(max(low, 0), count)
        return low, min(max(high, low), count)

    def replace(row, low, high, values):
        # PySequence_Fast is BEFORE clipping/length validation, and each write
        # is committed before the next. Retain old object cells until cleanup.
        sequence = io.row_sequence_fast(values)
        low, high = interval(row, low, high)
        count = len(sequence)
        if high - low != count:
            raise RuntimeError('Cannot modify row length')
        garbage = []
        for n in xrange(count):
            index = low + n
            if header(row)._columns[index][1] in (128, 129, 130):
                garbage.append(get(row, index))
            put(row, index, sequence[n])

    def equal(left, right):
        if type(right) is not Row:
            return False
        a, b = header(left), header(right)
        if a._columns != b._columns:
            return False
        a_columns, b_columns = a._columns, b._columns
        for i in xrange(len(a)):
            comparison = io.row_compare(get(left, i), get(right, i))
            stable(left, a, a_columns)
            stable(right, b, b_columns)
            if comparison:
                return False
        return True

    def raw_state_unavailable(*args):
        raise DomainError('Raw row serialization, reuse and Blue pickle identity are unavailable')

    class Row(object):
        __slots__ = ('_row_header', '_row_bytes', '_row_objects', '_row_initializing')
        __module__ = 'companion.row'

        def __new__(cls, *args, **ignored_keywords):
            if cls is not Row:
                raise DomainError('Native DBRow subclassing is unavailable')
            return object.__new__(cls)

        def __init__(self, *args, **ignored_keywords):
            try:
                raw_get(self, '_row_header')
            except AttributeError:
                pass
            else:
                raise DomainError('Repeated row initialization is outside this capability')
            if not args:
                raise ValueError('expected at least one argument')
            first = args[0]
            if type(first) is Row:
                if len(args) != 1:
                    raise TypeError('DBRow() takes exactly 1 argument (%d given)' % len(args))
                if raw_get(first, '_row_initializing') is not None:
                    raise DomainError('Copying an unfinished native row is outside this capability')
                if header(first)._unsafe or header(first)._setting:
                    raise DomainError('Copying an unsafe native row is outside this capability')
                raw_set(self, '_row_header', header(first))
                raw_set(self, '_row_bytes', bytearray(raw_get(first, '_row_bytes')))
                raw_set(self, '_row_objects', list(raw_get(first, '_row_objects')))
                raw_set(self, '_row_initializing', None)
                return
            if not isinstance(first, Descriptor):
                raise TypeError('expected DBRow or DBRowDescriptor as first argument')
            if len(args) > 3:
                raise ValueError('expected at most two arguments')
            packed, objects, real = io.row_storage(first)
            raw_set(self, '_row_header', first)
            raw_set(self, '_row_bytes', packed)
            raw_set(self, '_row_objects', objects)
            raw_set(self, '_row_initializing', None if len(args) == 1 else set())
            if len(args) == 1:
                return
            # No eager list conversion: sequence size, warning, then each
            # PySequence_GetItem/Set. Third reuse and all keywords are ignored.
            count = io.row_sequence_size(args[1])
            virtual = first._virtual
            allowed = len(first) - (0 if virtual is None else list.__len__(virtual))
            if count > allowed:
                raise TypeError('Sequence must be at most %d elements' % allowed)
            if count < allowed:
                io.row_warning('sequence is too short')
            for i in xrange(count):
                put(self, i, io.row_sequence_item(args[1], i))
            for i in xrange(count, allowed):
                put(self, i, None)
            raw_set(self, '_row_initializing', None)

        def __len__(self):
            return len(header(self))

        def __getitem__(self, key):
            return get(self, io.row_index(header(self), key))

        def __setitem__(self, key, value):
            put(self, io.row_index(header(self), key), value)

        def __delitem__(self, key):
            raise RuntimeError('cannot delete column')

        def __getattribute__(self, name):
            try:
                descriptor = header(self)
            except AttributeError:
                return raw_get(self, name)
            index = io.row_index(descriptor, name, 1)
            return raw_get(self, name) if index is None else get(self, index)

        def __setattr__(self, name, value):
            index = io.row_index(header(self), name, 1)
            if index is not None:
                put(self, index, value)
            elif name in Row.__slots__:
                raise DomainError('Private row storage cannot be replaced')
            else:
                raw_set(self, name, value)

        def __delattr__(self, name):
            index = io.row_index(header(self), name, 1)
            if index is not None:
                raise RuntimeError('Cannot delete a column from a DBRow')
            if name in Row.__slots__:
                raise DomainError('Private row storage cannot be deleted')
            object.__delattr__(self, name)

        @property
        def __header__(self):
            return header(self)

        @__header__.setter
        def __header__(self, value):
            if not isinstance(value, Descriptor):
                raise TypeError('require a DBRowDescriptor instance')
            current = header(self)
            if current._storage[:2] != value._storage[:2]:
                raise ValueError("header.Size() doesn't match")
            if raw_get(self, '_row_initializing') is not None:
                raise DomainError('Rebinding an unfinished native row is outside this capability')
            raw_set(self, '_row_header', value)

        @property
        def __keys__(self):
            return header(self).Keys()

        @property
        def __columns__(self):
            return header(self).Keys()

        def __getslice__(self, low, high):
            low, high = interval(self, low, high)
            return [get(self, i) for i in xrange(low, high)]

        def __setslice__(self, low, high, values):
            replace(self, low, high, values)

        def __delslice__(self, low, high):
            low, high = interval(self, low, high)
            if high != low:
                raise RuntimeError('Cannot modify row length')

        def __repr__(self):
            return '<DBRow object %s>' % repr([get(self, i) for i in xrange(len(header(self)))])

        def __eq__(self, other):
            return equal(self, other)

        def __ne__(self, other):
            return not equal(self, other)

        def __cmp__(self, other):
            if equal(self, other):
                return 0
            raise DomainError('Native row pointer ordering is outside this capability')

        def __hash__(self):
            raise DomainError('Native row pointer hashing is outside this capability')

        __data__ = property(raw_state_unavailable, raw_state_unavailable)
        __cdata__ = property(raw_state_unavailable, raw_state_unavailable)
        __getstate__ = raw_state_unavailable
        __setstate__ = raw_state_unavailable
        __reduce_ex__ = raw_state_unavailable

    result = types.ModuleType('companion.row_protocol')
    result.Row, result.descriptors = Row, protocol
    def sequence_get(row, index):
        # XUtil_Index calls the native sequence slot directly, bypassing
        # mapping/attribute hooks and negative normalization.
        if index < 0 or index >= len(header(row)):
            raise IndexError('index out of range: %d' % index)
        return get(row, index)
    result.sequence_get = sequence_get
    globals()['_companion_row_protocol'] = result
    return result


def _create_godma_rowset_types(owner, rows, error_log):
    # Original Python class bodies, real list/dict bases and SAME named Row.
    # Construction of these types is not a StateManager instance or Prime.
    import types, dis, weakref
    protocol = rows.descriptors
    if rows is not _create_row_protocol(protocol) or owner.construction.DBRowDescriptor is not protocol.Descriptor:
        raise TypeError('Godma rowsets require the same actual row/descriptor capabilities')
    existing = getattr(owner, 'rowset_types', None)
    if existing is not None:
        if existing.rows is not rows or existing.error_log is not error_log:
            raise TypeError('Godma rowset types cannot change their client owners')
        if existing.error is not None:
            raise existing.error[0], existing.error[1], existing.error[2]
        if not existing.complete:
            raise ImportError('Godma rowset type initialization is incomplete')
        return existing
    result = types.ModuleType('companion.godma_rowset_types')
    result.rows, result.error_log = rows, error_log
    result.complete, result.error = False, None
    owner.rowset_types = result  # Transparent partial preparation on failure.
    try:
        def source(name, suffix):
            prefix = name.rpartition('.')[0].replace('.', '/')
            code = zipimport.zipimporter(_archive + '/' + prefix).get_code(name)
            if code is None or not code.co_filename.replace('\\', '/').endswith(suffix):
                raise ImportError('Not the installed rowset source: ' + name)
            return code

        def definition(code, name):
            matches = [v for v in code.co_consts if type(v) is types.CodeType and v.co_name == name]
            if len(matches) != 1:
                raise ImportError('Ambiguous original rowset definition: ' + name)
            return matches[0]

        pyos = types.ModuleType('companion.rowset_pyos')
        pyos.XUtil_Index = _client_prefs_io.row_indexer(rows.Row, rows.sequence_get, protocol.DomainError)
        def unavailable_yield(*args):
            raise protocol.DomainError('Rowset BeNice requires the real yielding owner')
        pyos.BeNice = unavailable_yield
        construction = owner.construction
        construction.DBRow, construction.pyos = rows.Row, pyos
        result.pyos, result.construction = pyos, construction

        crowset = types.ModuleType('companion.crowset')
        namespace = crowset.__dict__
        namespace.update({'__name__': 'carbon.common.script.sys.crowset', '__builtins__': __builtins__,
                          'blue': construction, 'const': protocol.constants, 'weakref': weakref})
        code = source('carbon.common.script.sys.crowset', '/carbon/common/script/sys/crowset.py')
        for name, base in (('CRowset', list), ('CIndexedRowset', dict), ('CFilterRowset', dict)):
            namespace[name] = type(name, (base,), types.FunctionType(definition(code, name), namespace)())
        result.crowset = crowset

        godmarowset = types.ModuleType('companion.godmarowset')
        namespace = godmarowset.__dict__
        namespace.update({'__name__': 'eve.client.script.util.godmarowset', '__builtins__': __builtins__,
                          'blue': construction, 'types': types, 'log': error_log,
                          'CRowset': crowset.CRowset, 'CIndexedRowset': crowset.CIndexedRowset,
                          'CFilterRowset': crowset.CFilterRowset})
        code = source('eve.client.script.util.godmarowset', '/eve/client/script/util/godmarowset.py')
        namespace['rowsetIterator'] = types.FunctionType(definition(code, 'rowsetIterator'), namespace)
        for name, base in (('GodmaRowset', crowset.CRowset), ('GodmaIndexedRowset', crowset.CIndexedRowset),
                           ('GodmaFilterRowset', crowset.CFilterRowset)):
            namespace[name] = type(name, (base,), types.FunctionType(definition(code, name), namespace)())
        result.godmarowset = godmarowset

        # Extend the SAME original Godma globals. Wrapper/manager methods see
        # this client's real logger, rowsets, constants and construction owner.
        namespace = type(owner.instance).__dict__['__init__'].func_globals
        namespace.update({'godmarowset': godmarowset, 'log': error_log, 'sys': sys})
        code = source('eve.client.script.environment.godma', '/eve/client/script/environment/godma.py')
        for name in ('ItemWrapper', 'EffectWrapper'):
            namespace[name] = types.ClassType(name, (), types.FunctionType(definition(code, name), namespace)())
            setattr(result, name, namespace[name])
        manager = definition(code, 'StateManager')
        # Validate the ENTIRE definition-time graph before executing its
        # untouched original code. Its sole call constructs the class header;
        # all later operations make functions/defaults, never invoke methods.
        cursor, external, calls, functions = 0, set(), [], 0
        allowed = set(('LOAD_NAME', 'LOAD_ATTR', 'LOAD_CONST', 'STORE_NAME',
                       'BUILD_TUPLE', 'CALL_FUNCTION', 'MAKE_FUNCTION', 'LOAD_LOCALS', 'RETURN_VALUE'))
        while cursor < len(manager.co_code):
            offset = cursor
            opcode = ord(manager.co_code[cursor]); cursor += 1
            argument = None
            if opcode >= dis.HAVE_ARGUMENT:
                argument = ord(manager.co_code[cursor]) | ord(manager.co_code[cursor + 1]) << 8
                cursor += 2
            operation = dis.opname[opcode]
            if operation not in allowed:
                raise ImportError('Unsupported StateManager class instruction: ' + operation)
            if operation == 'LOAD_NAME':
                external.add(manager.co_names[argument])
            elif operation == 'CALL_FUNCTION':
                calls.append((offset, argument))
            elif operation == 'MAKE_FUNCTION':
                functions += 1
        if external != set(('__name__', 'blue', 'const', 'True', 'False')) or calls != [(261, 1)] or functions != 110:
            raise ImportError('Installed StateManager definition graph changed')
        cls = types.ClassType('StateManager', (), types.FunctionType(manager, namespace)())
        namespace['StateManager'] = cls
        result.StateManager = cls
        result.complete = True
    except BaseException:
        result.error = sys.exc_info()
        raise
    return result


def _prepare_godma_state_manager(owner, rowsets):
    # Construction preparation only. Original GetStateManager publishes onto
    # this SAME Godma slot. Runtime numeric publication belongs to the later
    # coordinated storage capability; no active cache is populated here.
    # InitializeData/Prime and native cold RPC yielding are separate demands.
    import types
    if getattr(owner, 'rowset_types', None) is not rowsets or not rowsets.complete:
        raise TypeError('StateManager requires the same complete original rowset types')
    existing = getattr(owner, 'constants_owner', None)
    if existing is not None:
        if existing.error is not None:
            raise existing.error[0], existing.error[1], existing.error[2]
        if not existing.complete:
            raise ImportError('Original Godma constants preparation is incomplete')
        return existing
    exceptions = rowsets.error_log._client_exceptions_owner
    if not exceptions.complete or exceptions.modules['eveexceptions'].UserError is not rowsets.error_log.UserError:
        raise TypeError('Godma constants must share the actual error consumer exception classes')
    suffixes = {}
    for name in ('carbon', 'carbon.common', 'carbon.common.lib', 'eve', 'eve.common', 'eve.common.lib',
                 'eve.common.script', 'eve.common.script.util'):
        suffixes[name] = '/' + name.replace('.', '/') + '/__init__.py'
    for name in ('crimewatch', 'dogma', 'eveexceptions', 'evefleet', 'eveuniverse', 'inventorycommon',
                 'itertoolsext', 'marketutil', 'probescanning', 'utillib', 'brennivin', 'caching'):
        suffixes[name] = '/packages/' + name + '/__init__.py'
    for name in ('carbon.common.lib.const', 'carbon.common.lib.session', 'eve.common.lib.appConst',
                 'eve.common.lib.infoEventConst', 'eve.common.script.util.notificationconst'):
        suffixes[name] = '/' + name.replace('.', '/') + '.py'
    for name in ('inventorycommon.const', 'dogma.const', 'crimewatch.const', 'eveexceptions.const',
                 'eveexceptions.exceptionEater', 'probescanning.const', 'evefleet.const', 'evefleet.error',
                 'evefleet.util', 'eveuniverse.security', 'marketutil.const', 'marketutil.skilllimits',
                 'caching.memoize', 'caching.lazy', 'brennivin.compat', 'brennivin.dochelpers',
                 'brennivin.itertoolsext'):
        suffixes[name] = '/packages/' + name.replace('.', '/') + '.py'
    # Reuse already executed actual VM helpers and the existing descriptor
    # constant owner. Do not extend carbon.const with hand-copied EVE values.
    seeds = dict(exceptions.modules)
    seeds['carbon.common.lib.const'] = rowsets.rows.descriptors.constants
    for name in suffixes:
        if (name == 'caching' or name.startswith('caching.') or name == 'brennivin' or name.startswith('brennivin.')) and name in sys.modules:
            seeds[name] = sys.modules[name]
    package = exceptions.modules['eveexceptions']
    graph = _create_original_module_graph(suffixes, {
        '__builtin__': package.__dict__['__builtin__'],
        'logging': exceptions.modules['eveexceptions.exceptionEater'].logging,
    }, seeds)
    graph.codes.update(exceptions.codes)
    owner.constants_owner = graph
    try:
        graph.appConst = graph.load('eve.common.lib.appConst')
        namespace = type(owner.instance).__dict__['__init__'].func_globals
        namespace['const'] = graph.appConst
        methods = [v for v in owner.source.co_consts if type(v) is types.CodeType and v.co_name == 'GetStateManager']
        if len(methods) != 1:
            raise ImportError('Ambiguous installed Godma.GetStateManager')
        type(owner.instance).GetStateManager = types.FunctionType(methods[0], namespace)

        def get_warm():
            # This guard does not execute arbitrary ==None twice. Header RPC
            # demand is explicit preparation, outside the original lazy call.
            if owner.instance.stateManager is None and owner.needs_remote('itemrd'):
                raise rowsets.rows.descriptors.DomainError('StateManager requires explicit asynchronous header preparation')
            return owner.instance.GetStateManager()

        owner.get_state_manager_warm = get_warm
        graph.complete = True
    except BaseException:
        graph.error = sys.exc_info()
        raise
    return graph


def _attach_godma_freshness(owner):
    # Source OnModuleAttributeChange_1316-1324 prefix, on the actual original
    # manager. Its original _IsAttributeChangeRelevant owns truth/comparison.
    # No mirrored dictionary, normalized keys, timestamps or cached decisions.
    import types
    existing = getattr(owner, 'freshness', None)
    if existing is not None:
        return existing
    result = types.ModuleType('companion.godma_freshness')

    def tuple_key(*parts):
        return parts

    def notice_prefix(manager, item, attribute, wallclock):
        if not manager._IsAttributeChangeRelevant(item, attribute, wallclock):
            return False
        if wallclock:
            manager.lastAttributeChange[(item, attribute)] = wallclock
        return True

    def replace(manager):
        # ProcessSessionChange1168 assigns a NEW dict, before Prime demand.
        manager.lastAttributeChange = {}
        return manager.lastAttributeChange

    def owns(item, owner_id, charid):
        # OnModuleAttributeChange_1325, AFTER the timestamp prefix. Read the
        # real effective session, including its pre-selection None value.
        return item == charid or owner_id == charid

    result.tuple_key, result.notice_prefix, result.replace = tuple_key, notice_prefix, replace
    result.owns = owns
    owner.freshness = result
    return result


def _attach_godma_inventory_rows(owner):
    # Sole numeric metadata authority on the same original manager. The
    # existing bounded notice/purge algorithm still owns async RPC/event work;
    # native invByID containers and whole original UpdateItem are not supplied.
    import types
    existing = getattr(owner, 'inventory_rows', None)
    if existing is not None:
        return existing
    rows = owner.rowset_types.rows
    result = types.ModuleType('companion.godma_inventory_rows')

    def raw_item(manager, item):
        # Indexed access intentionally creates a fresh ItemWrapper. Storage
        # and wire projections demand its actual shared BACKING row instead.
        return dict.__getitem__(manager.invitems, item)

    def native_keys(container):
        return container.keys()

    def new_values():
        return []

    def materialize(manager, values):
        return rows.Row(manager.invitems.header, values)

    def empty_set():
        return set()

    result.raw_item, result.native_keys = raw_item, native_keys
    result.new_values, result.materialize, result.empty_set = new_values, materialize, empty_set
    owner.inventory_rows = result
    return result


def _attach_inventory_session_checks(owner, context):
    # Genuine inventory MachoObjectConnection construction/weak registration.
    # The ObjectCall service/RPC scheduler and native containers are separate.
    import types, weakref
    existing = getattr(owner, 'inventory_session_checks', None)
    if existing is not None:
        if existing.context is not context:
            raise ValueError('Inventory checks must retain their actual native session context')
        return existing
    context.assert_entry()

    def module_code(name):
        full_name = 'carbon.common.script.net.' + name
        code = zipimport.zipimporter(_archive + '/carbon/common/script/net').get_code(full_name)
        if code is None or not code.co_filename.replace('\\', '/').endswith('/carbon/common/script/net/' + name + '.py'):
            raise ImportError('Not the installed native address dependency: ' + name)
        return code

    def definition(code, name):
        matches = [v for v in code.co_consts if type(v) is types.CodeType and v.co_name == name]
        if len(matches) != 1:
            raise ImportError('Ambiguous installed native address definition: ' + name)
        return matches[0]
    code = zipimport.zipimporter(_archive + '/carbon/common/script/net').get_code('carbon.common.script.net.ObjectCallGPCS')
    if code is None or not code.co_filename.replace('\\', '/').endswith('/carbon/common/script/net/ObjectCallGPCS.py'):
        raise ImportError('Not the installed remote object session-check source')
    classes = [v for v in code.co_consts if type(v) is types.CodeType and v.co_name == 'MachoObjectConnection']
    if len(classes) != 1:
        raise ImportError('Ambiguous installed MachoObjectConnection')
    methods = [v for v in classes[0].co_consts if type(v) is types.CodeType and v.co_name == 'PerformSessionCheck']
    if len(methods) != 1:
        raise ImportError('Ambiguous installed remote session check')
    godma_globals = type(owner.instance).__dict__['__init__'].func_globals
    namespace = {'__name__': 'carbon.common.script.net.ObjectCallGPCS', '__builtins__': __builtins__,
                 'log': godma_globals['log'], 'weakref': weakref, 'sys': sys}
    result = types.ModuleType('companion.inventory_connections')
    # Execute genuine selected exception CLASS bodies; importing the whole GPS
    # module would publish shared builtins and admit unrelated engine clocks.
    exception_namespace = {'__name__': 'carbon.common.script.net.GPSExceptions', '__builtins__': __builtins__}
    exception_source = module_code('GPSExceptions')
    gps_exception = type('GPSException', (StandardError,), types.FunctionType(definition(exception_source, 'GPSException'), exception_namespace)())
    exception_namespace['GPSException'] = gps_exception
    bad_address = type('GPSBadAddress', (gps_exception,), types.FunctionType(definition(exception_source, 'GPSBadAddress'), exception_namespace)())
    exception_namespace['GPSBadAddress'] = bad_address
    session_globals = context.source_classes[0].__dict__['Masquerade'].func_globals
    session_globals['log'] = godma_globals['log']
    address_namespace = {'__name__': 'carbon.common.script.net.machoNetAddress', '__builtins__': __builtins__,
                         'GPSBadAddress': bad_address, 'const': owner.constants_owner.modules['carbon.common.lib.const'],
                         'log': godma_globals['log'], 'strx': session_globals['strx'], 'machobase': session_globals['machobase']}
    address = types.ClassType('MachoAddress', (), types.FunctionType(definition(module_code('machoNetAddress'), 'MachoAddress'), address_namespace)())
    namespace.update({'MachoAddress': address, 'strx': session_globals['strx'],
                      'boot': context.boot, 'macho': session_globals['machobase']})
    wrapper = types.ClassType('MachoObjectCallWrapper', (), types.FunctionType(definition(code, 'MachoObjectCallWrapper'), namespace)())
    namespace['MachoObjectCallWrapper'] = wrapper
    connection_type = types.ClassType('MachoObjectConnection', (), types.FunctionType(classes[0], namespace)())
    # SAME prelogin connection-field owner, including its actual release queue.
    # No ObjectCallWithoutTheStars/ThrottledCall service provider is installed.
    connection_fields = context.object_call_fields
    perform = connection_type.__dict__['PerformSessionCheck']
    result.context, result.MachoAddress, result.GPSBadAddress = context, address, bad_address
    result.MachoObjectConnection, result.connection_fields = connection_type, connection_fields

    def new_policy():
        return {}

    def wire_tuple(*values):
        return values

    def new_list():
        return []

    def receipt(context, object_id, public_attributes, ref_id):
        context.assert_entry()
        return connection_type(context.fields, connection_fields, object_id, public_attributes, ref_id)

    def check_current(context, record):
        # Original getter's PerformSessionCheck precedes the call wrapper's
        # current-client check (ObjectCallGPCS586-625). RPC remains managed;
        # do not pretend the original synchronous wrapper's scheduler is ready.
        perform(record)
        if context.connection_fields.GetClientSessionID() != record.clisid:
            raise RuntimeError('This object was acquired by a different session')

    def perform_in_context(context, record):
        if record.session.GetActualSession() is not context.fields:
            raise ValueError('Inventory checks must use their actual native session owner')
        return context.run_masked(check_current, (context, record))

    result.new_policy, result.receipt, result.perform = new_policy, receipt, perform
    result.wire_tuple, result.new_list = wire_tuple, new_list
    result.perform_in_context = perform_in_context

    # Original Moniker constructor/helpers, separate from its unprepared
    # synchronous Bind/uthread/service scheduler. Its destructor needs the
    # actual local ObjectConnection TYPE for isinstance, never its constructor
    # or basesession's module-scope ObjectKillah tasklet.
    session_source = zipimport.zipimporter(_archive + '/carbon/common/script/sys').get_code('carbon.common.script.sys.basesession')
    local_connection = types.ClassType('ObjectConnection', (), types.FunctionType(definition(session_source, 'ObjectConnection'), session_globals)())
    local_type_owner = types.ModuleType('companion.local_object_connection_type')
    local_type_owner.ObjectConnection = local_connection
    moniker_source = module_code('moniker')
    moniker_namespace = {'__name__': 'carbon.common.script.net.moniker', '__builtins__': __builtins__,
                         'allMonikers': weakref.WeakSet(), 'basesession': local_type_owner,
                         'session': context.session, 'log': godma_globals['log']}
    moniker_type = types.ClassType('Moniker', (), types.FunctionType(definition(moniker_source, 'Moniker'), moniker_namespace)())
    moniker_namespace['Moniker'] = moniker_type
    moniker_namespace['MonikerCallWrap'] = types.ClassType('MonikerCallWrap', (), types.FunctionType(definition(moniker_source, 'MonikerCallWrap'), moniker_namespace)())
    eve_source = zipimport.zipimporter(_archive + '/eve/common/script/net').get_code('eve.common.script.net.eveMoniker')
    if eve_source is None or not eve_source.co_filename.replace('\\', '/').endswith('/eve/common/script/net/eveMoniker.py'):
        raise ImportError('Not the installed inventory Moniker helper source')
    eve_namespace = {'__name__': 'eve.common.script.net.eveMoniker', '__builtins__': __builtins__,
                     'Moniker': moniker_type, 'session': context.session, 'const': owner.constants_owner.appConst}
    for name in ('GetSolarSystemInventoryMgr', 'GetStationInventoryMgr', 'GetInventoryMgr'):
        eve_namespace[name] = types.FunctionType(definition(eve_source, name), eve_namespace)

    def manager(which):
        context.assert_entry()
        if which == 'location':
            return context.run_masked(eve_namespace['GetInventoryMgr'])
        if which == 'station':
            return context.run_masked(eve_namespace['GetStationInventoryMgr'], (context.fields.stationid,))
        raise ValueError('Unknown inventory manager')

    def check_manager(moniker):
        return context.run_masked(moniker._Moniker__PerformSessionCheck)

    def resolve_manager(moniker, node_id):
        # Actual MachoResolveObject/typed address-cache result, not parsed N=.
        moniker._Moniker__nodeID = node_id
        check_manager(moniker)

    def publish_manager(moniker, record):
        # moniker.Bind144-145, AFTER ParseObjectID's original constructor and
        # weak registration. No copied bind params or per-N identity owner.
        moniker.boundObject = record
        record.persistantObjectID = (moniker._Moniker__serviceName, moniker._Moniker__bindParams)

    result.Moniker, result.ObjectConnection = moniker_type, local_connection
    result.all_monikers, result.manager_helpers = moniker_namespace['allMonikers'], eve_namespace
    result.manager, result.check_manager = manager, check_manager
    result.resolve_manager, result.publish_manager = resolve_manager, publish_manager
    result.containers = _attach_inventory_container_types(owner, result)
    owner.inventory_session_checks = result
    return result


def _attach_inventory_container_types(owner, checks):
    # Genuine constructor/wrapper field phase on the SAME existing broker.
    # Native fields are canonical storage for the managed async producer.
    # Full original notice/Prime, invByID admission and synchronous password/
    # RPC/service continuations remain separate capabilities.
    import types
    existing = getattr(owner, 'inventory_container_types', None)
    if existing is not None:
        if existing.error is not None:
            raise existing.error[0], existing.error[1], existing.error[2]
        if not existing.complete or existing.checks is not checks:
            raise ImportError('Original inventory container preparation is incomplete')
        return existing
    result = types.ModuleType('companion.inventory_container_types')
    result.complete, result.error, result.checks = False, None, checks
    owner.inventory_container_types = result
    try:
        code = zipimport.zipimporter(_archive + '/eve/client/script/environment').get_code('eve.client.script.environment.invCache')
        if code is None or not code.co_filename.replace('\\', '/').endswith('/eve/client/script/environment/invCache.py'):
            raise ImportError('Not the installed inventory container source')

        def definition(name):
            matches = [v for v in code.co_consts if type(v) is types.CodeType and v.co_name == name]
            if len(matches) != 1:
                raise ImportError('Ambiguous original inventory container definition: ' + name)
            return matches[0]

        graph = owner.constants_owner
        namespace = {'__name__': 'eve.client.script.environment.invCache', '__builtins__': __builtins__,
                     'const': graph.appConst, 'session': checks.context.session, 'sys': sys,
                     'Memoize': graph.load('caching.memoize').Memoize, 'Moniker': checks.Moniker,
                     'UserError': owner.rowset_types.error_log.UserError}
        # Original Memoize(1) creates ONE shared native 60-second closure for
        # this class, using real stdlib time/numbers, never a per-guard cache.
        for name in ('PasswordHandlerCallWrapper', 'PasswordHandlerObjectWrapper', 'FastInvCallWrapper', 'invCacheContainer'):
            namespace[name] = types.ClassType(name, (), types.FunctionType(definition(name), namespace)())
            setattr(result, name, namespace[name])
        broker = owner.dependencies.GetService('invCache')
        # Selected original Initialize108 dictionary field only. Do not Run or
        # Initialize the broker again: that would reset its actual header and
        # managers and require an unprepared native semaphore/service graph.
        if 'inventories' not in broker.__dict__:
            broker.inventories = {}
        result.broker, result.namespace = broker, namespace

        def key(which, item):
            if which == 'hangar':
                return (graph.appConst.containerHangar, None)
            if which == 'structure':
                return (checks.context.fields.structureid, None)
            if which == 'item':
                return (item, None)
            raise ValueError('Unknown original container key domain')

        def construct(remote, key):
            if not isinstance(remote, checks.MachoObjectConnection):
                raise TypeError('An actual original remote inventory connection is required')
            return namespace['invCacheContainer'](remote, key, broker)

        def publish(guard):
            if guard.broker is not broker:
                raise ValueError('Container must retain its actual broker')
            broker.inventories[guard.key] = guard

        def unpublish(guard, detach=False):
            if broker.inventories.get(guard.key) is guard:
                if detach:
                    guard.moniker = None  # Original InvalidateLocationCache594-605.
                del broker.inventories[guard.key]
                return True
            return False

        def invalidate_container_fields():
            # Original InvalidateCache575-577 container field phase: detach
            # retained guards before replacing the dictionary. Single drops
            # above deliberately retain the guard's remote wrapper.
            for guard in broker.inventories.itervalues():
                guard.moniker = None
            broker.inventories = {}

        def set_self_item(guard, item):
            # _SetItemData971-974 AFTER the real async GetSelfInvItem reply.
            # Keep completed assignments if a later field read fails.
            guard._item = item
            guard._itemID = guard._item.itemID
            guard._typeID = guard._item.typeID

        def next_value(iterator):
            try:
                return (True, iterator.next())
            except StopIteration:
                return (False, None)

        def new_listing():
            return owner.rowset_types.crowset.CRowset(broker.GetItemHeader(), [])

        def finish_listing(guard, res, flags, many, has_type, type_id):
            # Source port of cache-only List1153-1165/ListByFlags1188-1204.
            # Caller owns their different header demand order. No fake RPC.
            for item_id in guard.cachedItems.iterkeys():
                item = guard.cachedItems[item_id]
                if many:
                    if item.flagID not in flags:
                        continue
                elif flags is not None and item.flagID != flags:
                    continue
                if has_type and item.typeID != type_id:
                    continue
                if len(item) != len(res.header):
                    guard.LogError('Invalid Item', item)
                    continue
                res.append(item)
            return res

        result.set_self_item, result.next_value = set_self_item, next_value
        result.new_listing, result.finish_listing = new_listing, finish_listing
        result.key, result.construct, result.publish = key, construct, publish
        result.unpublish, result.invalidate_container_fields = unpublish, invalidate_container_fields
        result.complete = True
    except BaseException:
        result.error = sys.exc_info()
        raise
    return result


def _attach_godma_effect_rows(owner):
    # Named source port of RefreshItemEffects1647-1682 and the cached-row
    # prefix of OnGodmaShipEffect1448-1459. The original service scatter,
    # control gate, tasklet/ActualStopEffect and overload tail remain external;
    # never replace the original handler with a collector or fake services.
    import types
    existing = getattr(owner, 'effect_rows', None)
    if existing is not None:
        return existing
    namespace = type(owner.instance).__dict__['__init__'].func_globals
    rows = owner.rowset_types.rows
    KeyVal = owner.constants_owner.modules['utillib'].KeyVal
    result = types.ModuleType('companion.godma_effect_rows')

    def new_dict():
        return {}

    def new_list():
        return []

    def new_info():
        return KeyVal()

    def refresh_rows(manager, item, type_id, info, do_update):
        data, const = owner.manager_data.data, namespace['const']
        eff_lines, event_lines = [], []
        active = info.activeEffects
        for relation in data.get_type_effects(type_id):
            effect_id = relation.effectID
            effect = data.get_effect(effect_id)
            categories = (const.dgmEffActivation, const.dgmEffTarget, const.dgmEffArea, const.dgmEffOverload)
            if (relation.isDefault and effect_id != const.effectSkillEffect or
                    effect_id in manager.requiredEffects or effect.effectCategory in categories or
                    effect.fittingUsageChanceAttributeID is not None):
                line = rows.Row(manager.__effectheader__, [
                    item, effect.effectID, effect.effectName, effect.effectCategory,
                    relation.isDefault, effect_id in active, effect.isOffensive, effect.isAssistance,
                    data.get_effect_description(effect.effectID), effect.trackingSpeedAttributeID,
                    effect.rangeAttributeID, effect.falloffAttributeID, effect.dischargeAttributeID,
                    effect.durationAttributeID, effect.iconID, None, None, None, None, False])
                eff_lines.append(line)
                manager.godma.LogInfo('RefreshItemEffects.effectsByItemEffect', item, effect_id, eff_lines[-1])
                if effect_id in active and effect.effectCategory in categories and effect_id not in manager.requiredEffects:
                    d = active[effect_id]
                    env = d[:7]
                    start_time, duration, repeat = d[7], d[8], d[9]
                    event_lines.append((item, effect_id, info.time, True, True, env, start_time, duration, repeat, None))
        if do_update and item in manager.effectsByItemEffect:
            index = manager.effectsByItemEffect[item].header.Index('effectName')
            for line in eff_lines:
                manager.effectsByItemEffect[item][line[index]] = line
        else:
            manager.effectsByItemEffect[item] = namespace['godmarowset'].GodmaRowset(
                manager.__effectheader__, eff_lines, rowClass=manager.GetEffectWrapper).Index('effectName')
        return event_lines

    def apply_fields(manager, args):
        item, effect_id, t, start, active, environment, start_time, duration, repeat = args[:9]
        effect = owner.manager_data.data.get_effect(effect_id)
        name = effect.effectName
        if item in manager.effectsByItemEffect and name in manager.effectsByItemEffect[item]:
            manager.godma.LogInfo('OnGodmaShipEffect.effectsByItemEffect', item, name, active, duration, repeat)
            manager.effectsByItemEffect[item][name].isDeactivating = False
            manager.effectsByItemEffect[item][name].isActive = active
            manager.effectsByItemEffect[item][name].startTime = start_time
            manager.effectsByItemEffect[item][name].duration = duration
            manager.effectsByItemEffect[item][name].repeat = repeat
            manager.effectsByItemEffect[item][name].targetID = environment[3]
            return (effect, bool(active))
        return None

    def raw_effect(manager, item, name):
        return dict.__getitem__(manager.effectsByItemEffect[item], name)

    def native_keys(container):
        return container.keys()

    def drop(manager, item):
        try:
            del manager.effectsByItemEffect[item]
        except KeyError:
            pass

    result.new_dict, result.new_list, result.new_info = new_dict, new_list, new_info
    result.refresh_rows, result.apply_fields = refresh_rows, apply_fields
    result.raw_effect, result.native_keys, result.drop = raw_effect, native_keys, drop
    owner.effect_rows = result
    return result


def _attach_godma_numeric_values(owner):
    # Actual original-manager dictionaries/lists, never a second value/kind
    # registry. Refresh executes the untouched installed original method.
    import types, math
    existing = getattr(owner, 'numeric_values', None)
    if existing is not None:
        return existing
    data = getattr(owner, 'manager_data', None)
    if data is None:
        raise RuntimeError('Godma numeric values require the same prepared data owner')
    code = zipimport.zipimporter(_archive + '/dogma').get_code('dogma.data')
    if code is None or not code.co_filename.replace('\\', '/').endswith('/packages/dogma/data.py'):
        raise ImportError('Not the installed Godma numeric data helper source')
    for name in ('get_attribute', 'get_attribute_name'):
        if name not in data.data.__dict__:
            matches = [v for v in code.co_consts if type(v) is types.CodeType and v.co_name == name]
            if len(matches) != 1:
                raise ImportError('Ambiguous installed Godma numeric helper: ' + name)
            setattr(data.data, name, types.FunctionType(matches[0], data.data.__dict__))
    namespace = type(owner.instance).__dict__['__init__'].func_globals
    if 'math' in namespace and namespace['math'] is not math:
        raise TypeError('Original Godma math already has a different owner')
    namespace['math'] = math
    KeyVal = owner.constants_owner.modules['utillib'].KeyVal
    result = types.ModuleType('companion.godma_numeric_values')

    def new_info(time, wallclock):
        return KeyVal(time=time, wallclockTime=wallclock, attributes={})

    def ensure_charge_item(manager, item):
        if item not in manager.chargedAttributesByItemAttribute:
            manager.chargedAttributesByItemAttribute[item] = {}

    def ratio_charge(charge, new, old):
        # ApplyAttributeChange2559-2564, AFTER the scalar store. Always
        # calculate the ratio before testing whether charge equals old.
        ratio = float(new) / old
        if charge == old:
            charge = charge * ratio
        if charge > new:
            charge = new
        return charge

    def equal(left, right):
        return left == right

    def zero_capacity(state):
        return state[3] == 0

    def charge_at(manager, state, time):
        return manager.GetChargeValue(state[0], state[1], state[2], state[3], time)

    def drop(manager, item):
        # Attribute/charge part of PurgeEntry2519; freshness is independent.
        for container in (manager.attributesByItemAttribute, manager.chargedAttributesByItemAttribute):
            try:
                del container[item]
            except KeyError:
                pass

    result.new_info, result.ensure_charge_item = new_info, ensure_charge_item
    result.ratio_charge, result.equal = ratio_charge, equal
    result.zero_capacity, result.charge_at, result.drop = zero_capacity, charge_at, drop
    owner.numeric_values = result
    return result


def _attach_godma_state_manager_data(owner, data):
    # Bind this SAME selected original dogma.data capability, already owned by
    # the native static service. No second FSD load/name map/recharge memoizer,
    # full dogma.data module startup, or active gameplay cache is synthesized.
    import types
    graph = getattr(owner, 'constants_owner', None)
    if graph is None or not graph.complete:
        raise RuntimeError('Original StateManager construction must be prepared first')
    base_globals = owner.service_types.BaseDogmaStaticSvc.__dict__['__init__'].func_globals
    if base_globals.get('dogma_data') is not data:
        raise TypeError('StateManager data must be the same native static service data owner')
    existing = getattr(owner, 'manager_data', None)
    if existing is not None:
        if existing.data is not data:
            raise TypeError('StateManager cannot change its actual static data owner')
        return existing
    dogma, constants = graph.modules['dogma'], graph.modules['dogma.const']
    if hasattr(dogma, 'data') and dogma.data is not data:
        raise TypeError('Original dogma parent already has a different data owner')
    if 'dogma.data' in graph.modules and graph.modules['dogma.data'] is not data:
        raise TypeError('Original dogma graph already has a different data owner')
    if (type(data.attributeDataTypeTypeDamage) is not type(constants.attributeDataTypeTypeDamage) or
            data.attributeDataTypeTypeDamage != constants.attributeDataTypeTypeDamage):
        raise ValueError('Static data and original Godma attribute constants differ')
    # Demand the actual prepared original method, not a default/empty mapping.
    if not callable(data.get_attribute_list_by_charge_recharge_time_id):
        raise TypeError('Original memoized recharge grouping is unavailable')
    namespace = type(owner.instance).__dict__['__init__'].func_globals
    dogma.data = data
    graph.modules['dogma.data'] = data
    namespace['dogma'] = dogma
    namespace['attributeDataTypeTypeDamage'] = constants.attributeDataTypeTypeDamage
    result = types.ModuleType('companion.godma_state_manager_data')
    result.data, result.dogma, result.constants = data, dogma, constants

    def initialize_warm():
        # The original method owns its truth guard, ordered map assignments,
        # partial failures and LAST inited=True. No JS success/memo cache.
        return owner.get_state_manager_warm().InitializeData()

    result.initialize_warm = initialize_warm
    owner.manager_data = result
    return result


def _attach_godma_type_wrappers(owner, full_load):
    # Complete original TypeWrapper class and its selected original helpers on
    # the SAME static/data/localization/Godma owners. These are per-type static
    # definitions; runtime item/effect maps remain unprimed and inactive.
    import types
    data_owner = getattr(owner, 'manager_data', None)
    if data_owner is None or full_load.types is not owner.service_types or full_load.data is not data_owner.data:
        raise TypeError('TypeWrapper must share the same prepared static data owner')
    existing = getattr(owner, 'type_wrappers', None)
    if existing is not None:
        if existing.full_load is not full_load:
            raise TypeError('TypeWrapper cannot change its actual static/localization owners')
        if existing.error is not None:
            raise existing.error[0], existing.error[1], existing.error[2]
        if not existing.complete:
            raise ImportError('Original TypeWrapper preparation is incomplete')
        return existing
    data, evetypes = full_load.data, full_load.evetypes
    base_globals = owner.service_types.BaseDogmaStaticSvc.__dict__['__init__'].func_globals
    if base_globals['evetypes'] is not evetypes or data.evetypes is not evetypes:
        raise TypeError('TypeWrapper requires the same existing phased evetypes namespace')
    result = types.ModuleType('companion.godma_type_wrappers')
    result.full_load, result.data, result.evetypes = full_load, data, evetypes
    result.complete, result.error = False, None
    owner.type_wrappers = result
    try:
        def source(name, suffix):
            prefix = name.rpartition('.')[0].replace('.', '/')
            code = zipimport.zipimporter(_archive + ('/' + prefix if prefix else '')).get_code(name)
            if code is None or not code.co_filename.replace('\\', '/').endswith(suffix):
                raise ImportError('Not the installed TypeWrapper dependency: ' + name)
            return code

        def definition(code, name):
            matches = [v for v in code.co_consts if type(v) is types.CodeType and v.co_name == name]
            if len(matches) != 1:
                raise ImportError('Ambiguous installed TypeWrapper definition: ' + name)
            return matches[0]

        graph = owner.constants_owner
        if 'evetypes' in graph.modules and graph.modules['evetypes'] is not evetypes:
            raise TypeError('Original module graph already has another evetypes owner')
        graph.modules['evetypes'] = evetypes
        localization = full_load.localized.localization
        bindings = data.__dict__.setdefault('_CLIENT_IMPORT_BINDINGS', {})
        if 'localization' in bindings and bindings['localization'] is not localization:
            raise TypeError('Original data helpers already use another localization owner')
        bindings['localization'] = localization
        code = source('dogma.data', '/packages/dogma/data.py')
        for name in ('get_attribute', 'get_attribute_data_type', 'get_attribute_display_name',
                     'get_effect', 'get_type_effects', 'get_effect_description'):
            if name not in data.__dict__:
                setattr(data, name, types.FunctionType(definition(code, name), data.__dict__))
        evetypes.GetLocalizedTypeName = full_load.localized.GetLocalizedTypeName
        code = source('evetypes', '/packages/evetypes/__init__.py')
        for name in ('GetNameID', 'GetName', 'GetAttributeForType'):
            if name not in evetypes.__dict__:
                defaults = (None, True) if name == 'GetName' else None
                setattr(evetypes, name, types.FunctionType(definition(code, name), evetypes.__dict__, name, defaults))
        namespace = type(owner.instance).__dict__['__init__'].func_globals
        constants = graph.modules['dogma.const']
        for name in ('attributeDataTypeInstanceBoolean', 'attributeDataTypeInstanceInteger',
                     'attributeDataTypeTypeAttributeId', 'attributeDataTypeTypeBoolean',
                     'attributeDataTypeTypeDamage', 'attributeDataTypeTypeGroupId',
                     'attributeDataTypeTypeInteger', 'attributeDataTypeTypeMirror', 'attributeDataTypeTypeTypeId'):
            namespace[name] = getattr(constants, name)
        namespace['evetypes'] = evetypes
        namespace['CRowset'] = owner.rowset_types.crowset.CRowset
        code = source('eve.client.script.environment.godma', '/eve/client/script/environment/godma.py')
        cls = type('TypeWrapper', (object,), types.FunctionType(definition(code, 'TypeWrapper'), namespace)())
        namespace['TypeWrapper'] = result.TypeWrapper = cls

        def get_warm(type_id):
            return owner.get_state_manager_warm().GetType(type_id)

        def read_warm(type_id, name):
            return getattr(get_warm(type_id), name)

        def attribute_exists_warm(type_id, name):
            return get_warm(type_id).AttributeExists(name)

        result.get_warm, result.read_warm, result.attribute_exists_warm = get_warm, read_warm, attribute_exists_warm
        result.complete = True
    except BaseException:
        result.error = sys.exc_info()
        raise
    return result


def _create_inventory_header_owner(service_types):
    # Core construction and the ONE Initialize108 field only. This selected
    # capability does not run invCache.Initialize's semaphore/service graph.
    import types
    name = 'eve.client.script.environment.invCache'
    prefix = name.rpartition('.')[0].replace('.', '/')
    source = zipimport.zipimporter(_archive + '/' + prefix).get_code(name)
    if source is None or not source.co_filename.replace('\\', '/').endswith('/eve/client/script/environment/invCache.py'):
        raise ImportError('Not the installed inventory cache source')
    def definition(code, name):
        matches = [v for v in code.co_consts if type(v) is types.CodeType and v.co_name == name]
        if len(matches) != 1:
            raise ImportError('Ambiguous installed inventory definition: ' + name)
        return matches[0]
    source = definition(source, 'invCache')
    guids = [v for v in source.co_consts if type(v) is str and v == 'svc.invCache']
    if len(guids) != 1:
        raise ImportError('Installed inventory service guid is unavailable')
    namespace = {'__name__': name, '__builtins__': __builtins__}
    # Its native synchronous cold RPC producer remains absent. The JS owner
    # performs actual async demand/materialization first; only the untouched
    # ORIGINAL warm branch executes here. Never return a prepared fake RPC.
    method = types.FunctionType(definition(source, 'GetItemHeader'), namespace, 'GetItemHeader', (0,))
    core = service_types.CoreService
    if 'LogInfo' not in core.__dict__:
        raise RuntimeError('Original Core.LogInfo must be attached before inventory header construction')
    cls = type('CompanionInventoryHeader', (core,), {
        '__module__': 'companion.inventory_header', '__guid__': guids[0], 'GetItemHeader': method})
    instance = cls()
    instance._invCache__itemhdr = None
    return instance


def _create_godma_header_owner(service_types, inventory_header, protocol):
    # Selected original constructor/fields/properties on the existing pilot's
    # capability. No full Godma Run, StateManager or Blue heap type is supplied.
    import types, dis
    name = 'eve.client.script.environment.godma'
    prefix = name.rpartition('.')[0].replace('.', '/')
    source = zipimport.zipimporter(_archive + '/' + prefix).get_code(name)
    if source is None or not source.co_filename.replace('\\', '/').endswith('/eve/client/script/environment/godma.py'):
        raise ImportError('Not the installed Godma source')
    def definition(code, name):
        matches = [v for v in code.co_consts if type(v) is types.CodeType and v.co_name == name]
        if len(matches) != 1:
            raise ImportError('Ambiguous installed Godma definition: ' + name)
        return matches[0]
    source = definition(source, 'Godma')
    rows, cursor = [], 0
    while cursor < len(source.co_code):
        opcode = ord(source.co_code[cursor])
        cursor += 1
        argument = None
        if opcode >= dis.HAVE_ARGUMENT:
            argument = ord(source.co_code[cursor]) | ord(source.co_code[cursor + 1]) << 8
            cursor += 2
        if opcode == dis.EXTENDED_ARG:
            raise ImportError('Unsupported Godma class instruction')
        rows.append((dis.opname[opcode], argument))
    def literal(name):
        stores = [i for i, (op, arg) in enumerate(rows) if op == 'STORE_NAME' and source.co_names[arg] == name]
        if len(stores) != 1:
            raise ImportError('Ambiguous Godma class literal: ' + name)
        end = stores[0]
        op, arg = rows[end - 1]
        if op == 'LOAD_CONST':
            return source.co_consts[arg]
        if op == 'BUILD_LIST':
            operands = rows[end - 1 - arg:end - 1]
            if len(operands) == arg and all(op == 'LOAD_CONST' for op, _ in operands):
                return [source.co_consts[value] for _, value in operands]
        raise ImportError('Godma metadata is not a closed literal: ' + name)
    core = service_types.CoreService
    if not isinstance(inventory_header, core) or inventory_header.__guid__ != 'svc.invCache':
        raise TypeError('Godma headers require the same Core inventory header owner')
    services = types.ModuleType('companion.godma_header_dependencies')
    def get_service(name):
        if name != 'invCache':
            raise RuntimeError('Godma header dependency is unavailable: ' + name)
        return inventory_header
    services.GetService = get_service
    construction = types.ModuleType('companion.godma_descriptor_construction')
    construction.DBRowDescriptor = protocol.Descriptor
    namespace = {'__name__': name, '__builtins__': __builtins__, 'sm': services,
                 'blue': construction, 'const': protocol.constants}
    attributes = {'__module__': 'companion.godma_headers'}
    for name in ('__guid__', '__dependencies__', '__startupdependencies__'):
        attributes[name] = literal(name)
    for name in ('__init__', 'Initialize', 'ReleaseStateManager', 'OnSessionReset'):
        attributes[name] = types.FunctionType(definition(source, name), namespace)
    for name in ('itemrd', 'sublocrd', 'subloc_internalrd'):
        attributes[name] = property(types.FunctionType(definition(source, name), namespace))
    cls = type('CompanionGodmaHeaders', (core,), attributes)
    namespace['Godma'] = cls  # Original __init__ uses this exact global in super.
    instance = cls()
    fields = {'itemrd': '_Godma__itemrd', 'sublocrd': '_Godma__sublocrd',
              'subloc_internalrd': '_Godma__subloc_internalrd'}
    def needs_remote(name):
        if name not in fields:
            raise KeyError(name)
        # Only source descriptor state is preflighted. Its length/truth is a
        # pure read; the untouched original property rechecks its current slot.
        if name != 'itemrd' and getattr(instance, fields[name]):
            return False
        return instance._Godma__itemrd is None and inventory_header._invCache__itemhdr is None
    def read_warm(name):
        if needs_remote(name):
            raise protocol.DomainError('Godma header requires real asynchronous inventory demand before native warm access')
        return getattr(instance, name)
    result = types.ModuleType('companion.godma_header_owner')
    result.instance, result.needs_remote, result.read_warm = instance, needs_remote, read_warm
    result.dependencies, result.construction = services, construction
    result.source = source
    result.service_types = service_types
    return result
