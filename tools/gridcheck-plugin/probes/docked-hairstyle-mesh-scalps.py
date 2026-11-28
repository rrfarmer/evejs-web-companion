import blue

SCALP_ONLY = (44, 47, 235, 249, 294, 296, 372, 379, 386, 387, 409, 421)


def observe():
    rows = []
    for entry in cfg.paperdollResources:
        parts = entry.resPath.lower().split('/')
        if (entry.paperdollResourceID in SCALP_ONLY or entry.typeID is not None or len(parts) != 4
                or parts[0] != 'hair' or parts[2] != 'types' or parts[3] != parts[1] + '.type'):
            continue
        gender = 'female' if entry.resGender == 0 else 'male'
        folder = 'res:/graphics/character/%s/paperdoll/hair/%s/' % (gender, parts[1])
        paths = {}
        for role, stem in (('diffuse', 'colorize_head_l'), ('zones', 'colorize_head_z'),
                           ('raw', 'comp_head_d'), ('normal', 'comp_head_n'), ('specular', 'comp_head_s')):
            candidates = [stem + suffix + '.png' for suffix in ('_512', '')]
            paths[role] = next((name for name in candidates if blue.paths.exists(folder + name)), None)
        rows.append(dict(id=entry.paperdollResourceID, gender=gender, style=parts[1], maps=paths))
    rows.sort(key=lambda row: row['id'])
    return dict(build=3698585, station=session.stationid, rows=rows)


result = observe()
