import blue

STYLES = (191, 208, 224, 249, 404)


def observe():
    location = cfg.paperdollModifierLocations.Get(5)
    rows = []
    for resource_id in STYLES:
        entry = cfg.paperdollResources.Get(resource_id)
        style = entry.resPath.lower().split('/')[1]
        gender = 'female' if entry.resGender == 0 else 'male'
        folder = 'res:/graphics/character/%s/paperdoll/hair/%s/' % (gender, style)
        rows.append(dict(id=resource_id, style=style, gender=gender, typeID=entry.typeID,
                         races=list(entry.empireRestrictions or ()),
                         variants=[v for v in ('v1', 'v2', 'v3')
                                   if blue.paths.exists(folder + v + '/metadata.yaml')
                                   or blue.paths.exists(folder + v + '/colorize_head_l_512.png')
                                   or blue.paths.exists(folder + v + '/hair_ponytail_short.gr2')
                                   or blue.paths.exists(folder + v + '/hair_ponytail_bun_large.gr2')
                                   or blue.paths.exists(folder + v + '/hair_ponytail_bun_small.gr2')]))
    color = next(row for row in cfg.paperdollColors if row.colorKey == 'hair')
    palettes = []
    for gender in (0, 1):
        primary, secondary = sm.GetService('character').GetHairColors(gender)
        palettes.append(dict(gender=gender, primary=[entry[0].lower() for entry in primary],
                             secondary=[entry[0].lower() for entry in secondary]))
    return dict(build=3698585, station=session.stationid, modifier=location.modifierKey,
                variationKey=location.variationKey, rows=rows, colorLocation=color.colorID,
                hasSecondary=color.hasSecondary, palettes=palettes)


result = observe()
