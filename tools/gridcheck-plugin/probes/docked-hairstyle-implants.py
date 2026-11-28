import blue

IMPLANTS = (44, 47, 386)


def observe():
    rows = []
    for resource_id in IMPLANTS:
        resource = cfg.paperdollResources.Get(resource_id)
        style = resource.resPath.split('/')[1].lower()
        folder = 'res:/graphics/character/male/paperdoll/hair/%s/' % style
        rows.append(dict(id=resource_id, style=style, gender=resource.resGender, typeID=resource.typeID,
                         races=list(resource.empireRestrictions or ()),
                         maps=[name for name in ('d', 'mn', 's') if blue.paths.exists(folder + 'comp_head_%s_512.png' % name)]))
    return dict(build=3698585, station=session.stationid, rows=rows)


result = observe()
