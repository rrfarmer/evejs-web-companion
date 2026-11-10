# Every DXBC blob in a file disassembled (d3dcompiler_47's D3DDisassemble, Windows), one .asm each, into a directory:
#   python dxbc_dis.py file out_dir
import ctypes, struct, sys, os
data = open(sys.argv[1], 'rb').read()
out = sys.argv[2]; os.makedirs(out, exist_ok=True)
d3d = ctypes.WinDLL('d3dcompiler_47.dll')
class Blob(ctypes.Structure): pass
D = d3d.D3DDisassemble
D.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint, ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
i = 0; n = 0
while True:
    i = data.find(b'DXBC', i)
    if i < 0: break
    size = struct.unpack_from('<I', data, i + 24)[0]
    blob = data[i:i+size]
    p = ctypes.c_void_p()
    buf = ctypes.create_string_buffer(blob, len(blob))
    hr = D(buf, len(blob), 0, None, ctypes.byref(p))
    if hr == 0:
        vt = ctypes.cast(ctypes.cast(p, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
        GetPtr = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p)(vt[3])
        GetSize = ctypes.WINFUNCTYPE(ctypes.c_size_t, ctypes.c_void_p)(vt[4])
        text = ctypes.string_at(GetPtr(p), GetSize(p)).decode('latin1')
        kind = 'ps' if '\nps_' in text else 'vs' if '\nvs_' in text else 'xx'
        open(os.path.join(out, f'{n:02d}_{kind}_{i}.asm'), 'w').write(text)
    else:
        print('fail', i, hex(hr & 0xffffffff))
    n += 1; i += 4
print(n, 'blobs')
