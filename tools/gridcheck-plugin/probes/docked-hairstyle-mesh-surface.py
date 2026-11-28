import blue

SCALP_ONLY = (44, 47, 235, 249, 294, 296, 372, 379, 386, 387, 409, 421)


def observe():
    rows = []
    for entry in cfg.paperdollResources:
        pieces = entry.resPath.lower().split('/')
        if (entry.paperdollResourceID in SCALP_ONLY or entry.typeID is not None or len(pieces) != 4
                or pieces[0] != 'hair' or pieces[2] != 'types' or pieces[3] != pieces[1] + '.type'):
            continue
        style = pieces[1]
        gender = 'female' if entry.resGender == 0 else 'male'
        folder = 'res:/graphics/character/%s/paperdoll/hair/%s/' % (gender, style)
        paths = {}
        for role, channel in (('normal', 'n'), ('specular', 's')):
            candidates = ['comp_hair_%s%s.png' % (channel, suffix) for suffix in ('_512', '')]
            paths[role] = next((name for name in candidates if blue.paths.exists(folder + name)), None)
        rows.append(dict(id=entry.paperdollResourceID, gender=gender, style=style,
                         normal=paths['normal'], specular=paths['specular']))
    rows.sort(key=lambda row: row['id'])
    return dict(build=3698585, station=session.stationid, rows=rows)


result = observe()
