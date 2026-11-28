from eve.common.script.paperDoll import paperDollDefinitions as paper_doll


def observe():
    converter = paper_doll.DNAConverter()
    locations = sorted([(row.sculptLocationID, row.weightKeyCategory, row.weightKeyPrefix)
                        for row in cfg.paperdollSculptingLocations])
    rows = converter.ExtractSculptRowsFromDollInfo(dict(faceModifiers={'jaw_downshape': 0.75,
        'jaw_leftshape': 0.25, 'nose_forwardshape': 0.4}, bodyShapes={'fatshape': 0.5}))
    return dict(station=session.stationid, locations=locations, rows=[list(row) for row in rows],
                directions=dict((name, [axis.field, axis.positive])
                                for name, axis in paper_doll.AXIS_DIRECTIONS.iteritems()))


result = observe()
