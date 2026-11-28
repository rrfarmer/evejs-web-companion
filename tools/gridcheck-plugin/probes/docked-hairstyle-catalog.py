def observe():
    rows = []
    for row in cfg.paperdollResources:
        if not row.resPath.lower().startswith('hair/'):
            continue
        rows.append(dict(id=row.paperdollResourceID, path=row.resPath, gender=row.resGender,
                         typeID=row.typeID, races=list(row.empireRestrictions or ())))
    rows.sort(key=lambda row: row['id'])
    return dict(build=3698585, station=session.stationid, characterID=session.charid, resources=rows)


result = observe()
