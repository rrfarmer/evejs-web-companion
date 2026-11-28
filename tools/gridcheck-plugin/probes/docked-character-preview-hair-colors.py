def observe():
    svc = sm.GetService('character')
    primary, secondary = svc.GetHairColors(1)
    color_names = dict((row.colorName.lower(), row.colorNameID) for row in cfg.paperdollColorNames)
    palettes = []
    for key, choices in (('07_a', primary), ('08_bc', secondary)):
        choice = next(row for row in choices if row[0].lower() == key)
        palettes.append(dict(key=key, id=color_names[key],
                             colors=[list(rgb[:3]) for rgb in choice[2]['colors']]))
    color = next(row for row in cfg.paperdollColors if row.colorKey == 'hair')
    return dict(build=3698585, station=session.stationid, colorLocation=color.colorID, palettes=palettes)


result = observe()
