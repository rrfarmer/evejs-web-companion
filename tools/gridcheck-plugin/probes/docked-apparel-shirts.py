import blue


def observe():
    loc = next(row for row in cfg.paperdollModifierLocations if row.modifierKey == 'topmiddle')
    rows = []
    for row in cfg.paperdollResources:
        gender = 'female' if row.resGender == 0 else 'male'
        family = 'shirtgf01' if gender == 'female' else 'shirtgm01'
        path = row.resPath.lower()
        if not path.startswith('topmiddle/' + family + '/types/') or row.typeID is not None:
            continue
        asset = 'res:/graphics/character/%s/paperdoll/%s' % (gender, path)
        rows.append(dict(id=row.paperdollResourceID, gender=gender, path=path,
                         races=list(row.empireRestrictions or ()), exists=blue.paths.exists(asset)))
    rows.sort(key=lambda row: row['id'])
    return dict(build=3698585, station=session.stationid, location=loc.modifierLocationID, rows=rows)


result = observe()
