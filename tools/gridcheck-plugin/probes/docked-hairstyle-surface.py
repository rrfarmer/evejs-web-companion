import blue

SCALP_STYLES = (235, 249, 294, 296, 372, 379, 387, 409, 421, 109, 208, 357)


def observe():
    rows = []
    for resource_id in SCALP_STYLES:
        entry = cfg.paperdollResources.Get(resource_id)
        style = entry.resPath.split('/')[1].lower()
        gender = 'female' if entry.resGender == 0 else 'male'
        folder = 'res:/graphics/character/%s/paperdoll/hair/%s/' % (gender, style)
        paths = {}
        for role, channel in (('normal', 'n'), ('specular', 's')):
            candidates = ['comp_head_%s%s.png' % (channel, suffix) for suffix in ('_512', '')]
            paths[role] = next((name for name in candidates if blue.paths.exists(folder + name)), None)
        rows.append(dict(id=resource_id, gender=gender, style=style, races=list(entry.empireRestrictions or ()),
                         normal=paths['normal'], specular=paths['specular']))
    return dict(build=3698585, station=session.stationid, rows=rows)


result = observe()
