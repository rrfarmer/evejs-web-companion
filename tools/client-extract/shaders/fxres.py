# An effect file (.sm_hi etc.) read as carbonengine/trinity Resources/Tr2EffectRes.cpp DoLoad does (version 5+):
# its permutations (name, default option, options) and its records; with options given (NAME=VALUE ...), the
# record GetShader would pick (index = sum of option index x product of earlier permutations' sizes) and its DXBC
# stages disassembled into a directory.
#   python fxres.py file.sm_hi                      -> permutations, record count
#   python fxres.py file.sm_hi out_dir NAME=VALUE.. -> the record's stages disassembled into out_dir, with their
#     constants (register, default value), resources (register, name, sRGB read) and samplers (filter, address)
# The client's dx11 effect files: tq/resfileindex_Windows.txt names each (res:/graphics/effect.dx11/...sm_hi) and its
# file under ResFiles.
import struct, sys, os, subprocess

path = sys.argv[1]
d = open(path, 'rb').read()
p = 0
def u32():
    global p
    v = struct.unpack_from('<I', d, p)[0]; p += 4; return v
def u8():
    global p
    v = d[p]; p += 1; return v

version = u32()
assert 5 <= version <= 15, version
if version >= 15:
    p += 4 + 32
st_size = u32()
st = d[p:p + st_size]; p += st_size
def s(off):
    e = st.find(b'\0', off)
    return st[off:e].decode('latin1')
perms = []
for _ in range(u8()):
    name = s(u32()); default = u8(); desc = s(u32())
    typ = u8() if version > 5 else 0
    opts = [s(u32()) for _ in range(u8())]
    perms.append((name, default, desc, typ, opts))
count = u32()
records = [struct.unpack_from('<III', d, p + 12 * i) for i in range(count)]
print('version', version, 'records', count)
for name, default, desc, typ, opts in perms:
    print(f'  {name}: default {opts[default] if default < len(opts) else default}  options {opts}  ({desc})')


# render states by name (trinityal Tr2RenderContextEnum.h RenderState; D3D9's values)
RS = {7: 'ZENABLE', 8: 'FILLMODE', 14: 'ZWRITEENABLE', 15: 'ALPHATESTENABLE', 19: 'SRCBLEND', 20: 'DESTBLEND',
      22: 'CULLMODE(1 none,2 cw,3 ccw)', 23: 'ZFUNC', 24: 'ALPHAREF', 25: 'ALPHAFUNC', 27: 'ALPHABLENDENABLE',
      52: 'STENCILENABLE', 61: 'DEPTH_CLIP_ENABLE', 168: 'COLORWRITEENABLE', 171: 'BLENDOP',
      206: 'SEPARATEALPHABLENDENABLE', 207: 'SRCBLENDALPHA', 208: 'DESTBLENDALPHA', 209: 'BLENDOPALPHA'}
NAMES = {0: 'vs', 1: 'ps', 2: 'gs', 3: 'hs', 4: 'ds', 5: 'cs'}
ADDR = {1: 'wrap', 2: 'mirror', 3: 'clamp', 4: 'border', 5: 'mirroronce'}
HERE = os.path.dirname(os.path.abspath(__file__))


class Rec:
    """A record as Tr2EffectDescription::Read reads it (version >= 14)."""
    def __init__(self, blob):
        self.b, self.q = blob, 0
    def r(self, fmt):
        v = struct.unpack_from('<' + fmt, self.b, self.q); self.q += struct.calcsize('<' + fmt)
        return v if len(v) > 1 else v[0]
    def rs(self):
        return s(self.r('I'))


def stage(R, out, label):
    typ = R.r('B'); size = R.r('I'); off = R.r('I'); R.r('III')
    name = NAMES.get(typ, str(typ)) + label
    tmp = os.path.join(out, f'{name}.bin')
    open(tmp, 'wb').write(st[off:off + size])
    subprocess.run([sys.executable, os.path.join(HERE, 'dxbc_dis.py'), tmp, os.path.join(out, name)], check=True, stdout=subprocess.DEVNULL)
    for _ in range(R.r('B')): R.r('BBBBBB')                       # pipeline inputs
    for _ in range(R.r('B')): R.r('B'); R.r('I'); R.r('I'); R.r('B')  # registers
    for _ in range(R.r('B')):                                     # static samplers
        R.r('I'); R.r('B'); R.r('BBBB'); R.r('BBB'); R.r('f'); R.r('BB'); R.r('B'); R.r('ff')
    consts = []
    for _ in range(R.r('I')):
        cn = R.rs(); co = R.r('I'); cz = R.r('I'); ct = R.r('B'); cd = R.r('B'); ce = R.r('I'); srgb = R.r('B'); auto = R.r('B')
        consts.append((cn, co, cz, ct, cd, ce, srgb, auto))
    vsize = R.r('I'); voff = R.r('I')
    values = st[voff:voff + vsize] if vsize else b''
    print(f'--- {name}: constants')
    for cn, co, cz, ct, cd, ce, srgb, auto in consts:
        dv = struct.unpack_from('<' + 'f' * (cz // 4), values, co) if values and co + cz <= len(values) and ct == 0 else None
        print(f'    {cn:28s} c{co // 16}.{"xyzw"[(co % 16) // 4]} size {cz} type {ct} dim {cd} elems {ce} srgb {srgb} auto {auto} default {dv}')
    print(f'--- {name}: resources')
    for _ in range(R.r('B')):
        reg = R.r('B'); rn = R.rs(); rt = R.r('B'); R.r('I'); srgb = R.r('B'); auto = R.r('B')
        print(f'    t{reg} {rn} type {rt} srgb {srgb} auto {auto}')
    print(f'--- {name}: samplers')
    for _ in range(R.r('B')):
        reg = R.r('B'); sn = R.rs(); R.r('B'); mn, mg, mp = R.r('BBB'); au, av, aw = R.r('BBB'); R.r('f'); R.r('B'); R.r('B'); R.r('ffff'); R.r('ff'); dyn = R.r('B')
        print(f'    s{reg} {sn} filter {mn},{mg},{mp} address {ADDR.get(au, au)},{ADDR.get(av, av)},{ADDR.get(aw, aw)} dynamic {dyn}')
    for _ in range(R.r('B')): R.r('B'); R.rs(); R.r('B'); R.r('I'); R.r('B')   # uavs
    for _ in range(R.r('B')):                                     # annotations
        R.rs(); t = R.r('B'); (R.rs() if t == 3 else R.r('I'))


if len(sys.argv) > 2:
    out = sys.argv[2]
    chosen = dict(a.split('=', 1) for a in sys.argv[3:])
    index, mult = 0, 1
    for name, default, desc, typ, opts in perms:
        v = opts.index(chosen[name]) if name in chosen else default
        index += v * mult; mult *= len(opts)
    rec = records[index]
    print('index', index, 'record', rec)
    assert rec[0] == index, 'records not in index order'
    os.makedirs(out, exist_ok=True)
    R = Rec(d[rec[1]:rec[1] + rec[2]])
    techniques = R.r('B')
    for ti in range(techniques):
        tech = R.rs()
        passes = R.r('B')
        print(f'##### technique {ti} {tech}: passes {passes}')
        for pi in range(passes):
            n = R.r('B')
            print(f'=== pass {pi}: {n} stages')
            for _ in range(n):
                stage(R, out, (f'_{tech}' if ti else '') + (f'{pi}' if pi else ''))
            states = [R.r('II') for _ in range(R.r('B'))]
            print('    render states', ', '.join(f'{RS.get(k, k)}={v}' for k, v in states))
        # raytracing libraries (version > 13)
        for _ in range(R.r('B')):
            R.r('I'); size = R.r('I'); R.r('I')
            for _ in range(R.r('I')): R.r('B'); R.rs()
            R.rs()
