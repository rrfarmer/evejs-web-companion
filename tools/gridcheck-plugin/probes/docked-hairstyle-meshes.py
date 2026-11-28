import blue

STYLES = {
    109: 'hair_ponytail_bun_small.gr2',
    208: 'hair_ponytail_01.gr2',
    357: 'hair_ponytail_short.gr2',
}


def observe():
    rows = []
    for resource_id in sorted(STYLES):
        resource = cfg.paperdollResources.Get(resource_id)
        style = resource.resPath.split('/')[1].lower()
        folder = 'res:/graphics/character/female/paperdoll/hair/%s/' % style
        rows.append(dict(id=resource_id, style=style, gender=resource.resGender,
                         typeID=resource.typeID, races=list(resource.empireRestrictions or ()),
                         mesh=STYLES[resource_id], meshExists=blue.paths.exists(folder + STYLES[resource_id]),
                         hairMap=blue.paths.exists(folder + 'colorize_hair_l.png'),
                         headMap=blue.paths.exists(folder + 'colorize_head_l.png')))
    return dict(build=3698585, station=session.stationid, rows=rows)


result = observe()
