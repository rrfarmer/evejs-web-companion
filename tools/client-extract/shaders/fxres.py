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
    blob = d[rec[1]:rec[1] + rec[2]]
    # the record as Tr2EffectDescription::Read has it (version >= 14): techniques, passes, stages
    os.makedirs(out, exist_ok=True)
    q = 0
    def r(fmt):
        global q
        v = struct.unpack_from('<' + fmt, blob, q); q += struct.calcsize('<' + fmt)
        return v if len(v) > 1 else v[0]
    def rs(): return s(r('I'))
    names = {0: 'vs', 1: 'ps', 2: 'gs', 3: 'hs', 4: 'ds', 5: 'cs'}
    ADDR = {1: 'wrap', 2: 'mirror', 3: 'clamp', 4: 'border', 5: 'mirroronce'}
    here = os.path.dirname(os.path.abspath(__file__))
    techniques = r('B')
    tech = rs()
    passes = r('B')
    stagecount = r('B')
    print('technique', tech, 'of', techniques, 'passes', passes, 'stages', stagecount)
    for _ in range(stagecount):
        typ = r('B'); size = r('I'); off = r('I'); tg = r('III')
        name = names.get(typ, typ)
        tmp = os.path.join(out, f'{name}.bin')
        open(tmp, 'wb').write(st[off:off + size])
        subprocess.run([sys.executable, os.path.join(here, 'dxbc_dis.py'), tmp, os.path.join(out, name)], check=True, stdout=subprocess.DEVNULL)
        for _ in range(r('B')): r('BBBBBB')                # pipeline inputs
        for _ in range(r('B')): r('B'); r('I'); r('I'); r('B')   # registers (type, index, arrayCount, space)
        for _ in range(r('B')):                             # static samplers
            reg = r('I'); r('B'); r('BBBB'); au, av, aw = r('BBB'); r('f'); r('BB'); r('B'); r('ff')
        consts = []
        for _ in range(r('I')):
            cn = rs(); co = r('I'); cz = r('I'); ct = r('B'); cd = r('B'); ce = r('I'); srgb = r('B'); auto = r('B')
            consts.append((cn, co, cz, ct, cd, ce, srgb, auto))
        vsize = r('I'); voff = r('I')
        values = st[voff:voff + vsize] if vsize else b''
        print(f'--- {name}: constants')
        for cn, co, cz, ct, cd, ce, srgb, auto in consts:
            dv = struct.unpack_from('<' + 'f' * (cz // 4), values, co) if values and co + cz <= len(values) and ct == 0 else None
            print(f'    {cn:28s} c{co // 16}.{"xyzw"[(co % 16) // 4]} size {cz} type {ct} dim {cd} elems {ce} srgb {srgb} auto {auto} default {dv}')
        print(f'--- {name}: resources')
        for _ in range(r('B')):
            reg = r('B'); rn = rs(); rt = r('B'); ra = r('I'); srgb = r('B'); auto = r('B')
            print(f'    t{reg} {rn} type {rt} srgb {srgb} auto {auto}')
        print(f'--- {name}: samplers')
        for _ in range(r('B')):
            reg = r('B'); sn = rs(); cmp_ = r('B'); mn, mg, mp = r('BBB'); au, av, aw = r('BBB'); bias = r('f'); an = r('B'); cf = r('B'); r('ffff'); r('ff'); dyn = r('B')
            print(f'    s{reg} {sn} filter {mn},{mg},{mp} address {ADDR.get(au, au)},{ADDR.get(av, av)},{ADDR.get(aw, aw)} dynamic {dyn}')
        for _ in range(r('B')): r('B'); rs(); r('B'); r('I'); r('B')   # uavs
        for _ in range(r('B')):                             # annotations
            rs(); t = r('B'); (rs() if t == 3 else r('I'))
