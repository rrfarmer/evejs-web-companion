import blue

SCALP_STYLES = (235, 249, 294, 296, 372, 379, 387, 409, 421)
MESH_STYLES = (109, 208, 357)


def observe():
    rows = []
    for resource_id in SCALP_STYLES + MESH_STYLES:
        resource = cfg.paperdollResources.Get(resource_id)
        style = resource.resPath.split('/')[1].lower()
        gender = 'female' if resource.resGender == 0 else 'male'
        folder = 'res:/graphics/character/%s/paperdoll/hair/%s/' % (gender, style)
        rows.append(dict(id=resource_id, style=style, gender=gender, typeID=resource.typeID,
                         races=list(resource.empireRestrictions or ()),
                         meshStyle=resource_id in MESH_STYLES,
                         diffuse=blue.paths.exists(folder + 'colorize_head_l.png'),
                         zones=blue.paths.exists(folder + 'colorize_head_z.png')))
    return dict(build=3698585, station=session.stationid, rows=rows)


result = observe()
