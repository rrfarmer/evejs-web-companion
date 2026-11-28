import blue


def observe():
    locations = dict((row.modifierKey, row.modifierLocationID)
                     for row in cfg.paperdollModifierLocations
                     if row.modifierKey == 'outer')
    rows = []
    for row in cfg.paperdollResources:
        gender = 'female' if row.resGender == 0 else 'male'
        path = row.resPath.lower()
        parts = path.split('/')
        if (len(parts) != 4 or parts[2] != 'types' or
                parts[0] != 'outer' or not parts[1].startswith('jacket') or row.typeID is not None):
            continue
        asset = 'res:/graphics/character/%s/paperdoll/%s' % (gender, path)
        rows.append(dict(id=row.paperdollResourceID, gender=gender, path=path,
                         races=list(row.empireRestrictions or ()), exists=blue.paths.exists(asset)))
    rows.sort(key=lambda row: row['id'])
    return dict(build=3698585, station=session.stationid, locations=locations, rows=rows)


result = observe()
