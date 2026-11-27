from eve.client.script.ui.shared.skins.defaultSkinSettings import get_default_skin_id_for_hull, set_default_skin_for_hull, clear_default_skin_for_hull
from localization import GetByLabel

hull = 32880
other = 670
saved = get_default_skin_id_for_hull(hull)
other_saved = get_default_skin_id_for_hull(other)
try:
    set_default_skin_for_hull(hull, 3288)
    first = get_default_skin_id_for_hull(hull)
    custom = 'a' * 64
    set_default_skin_for_hull(hull, custom)
    replaced = get_default_skin_id_for_hull(hull)
    clear_default_skin_for_hull(hull)
    result = dict(station=session.stationid, first=first, replaced=replaced,
                  cleared=get_default_skin_id_for_hull(hull) is None,
                  otherUntouched=get_default_skin_id_for_hull(other) == other_saved,
                  labels=[GetByLabel('UI/Skins/SetDefault'), GetByLabel('UI/Skins/RemoveDefault')])
finally:
    if saved is None:
        clear_default_skin_for_hull(hull)
    else:
        set_default_skin_for_hull(hull, saved)
