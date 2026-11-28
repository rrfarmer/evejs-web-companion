import blue

BODY = 'res:/graphics/character/%s/paperdoll/'
MALE = BODY % 'male'
FEMALE = BODY % 'female'


def observe():
    paths = dict(
        legacyMale=MALE + 'basenude/caucasianbody_d_512.png',
        genericMale=MALE + 'head/head_generic/genericmalebody_d_512.png',
        legacyFemale=FEMALE + 'basenude/caucasianbody_d_512.png',
        jacket=MALE + 'outer/jacketmm01/types/jacketmm01_brutor.type',
        shirt=MALE + 'topmiddle/shirtgm01/types/shirtgm01_extra03.type',
        torso=MALE + 'topinner/torso_nude/torso_nude.gr2',
        pants=MALE + 'bottomouter/pantsmm01/types/jacketmm01_vherokior.type',
        boots=MALE + 'feet/bootsmm01/types/bootsmm01_sebiestor.type')
    return dict(build=3698585, station=session.stationid,
                assets=dict((name, blue.paths.exists(resource)) for name, resource in paths.iteritems()),
                paths=paths,
                slots=dict((row.modifierKey, row.modifierLocationID)
                           for row in cfg.paperdollModifierLocations
                           if row.modifierKey in ('outer', 'topmiddle', 'bottomouter', 'feet')))


result = observe()
