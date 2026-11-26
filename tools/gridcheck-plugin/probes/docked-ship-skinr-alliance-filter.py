from cosmetics.common.ships.skins.util import SkinListingOrder
from eve.client.script.ui.cosmetics.ship.pages.store import storeSettings
from eve.client.script.ui.cosmetics.ship.pages.store.sections.alliance import (
    AllianceSectionFilterMenuButtonIcon, MAX_NUM_PER_PAGE, ViewAllAllianceListingsSection)

class PageCapture(object):

    def reset(self, hulls, order, ascending, page_size, listing_target_type, seller_membership_type):
        self.value = dict(hulls=hulls, order=order, ascending=ascending, pageSize=page_size,
                          target=listing_target_type, member=seller_membership_type)


menu = AllianceSectionFilterMenuButtonIcon.GetMenu(None)
options = [entry for entry in menu.GetEntries() if hasattr(entry, 'value')]
section = ViewAllAllianceListingsSection.__new__(ViewAllAllianceListingsSection)
section.num_per_page = MAX_NUM_PER_PAGE
section.apply_filtering = True
section.pagination_controller = PageCapture()
previous_hull = storeSettings.skins_hull_type_filter_setting.get()
previous_member = storeSettings.listed_by_setting.get()
queries = []
try:
    storeSettings.skins_hull_type_filter_setting.set(32880)
    for option in options:
        storeSettings.listed_by_setting.set(option.value)
        section.reset_pagination_controller(SkinListingOrder.EXPIRES_AT, False)
        queries.append(section.pagination_controller.value)
finally:
    storeSettings.skins_hull_type_filter_setting.set(previous_hull)
    storeSettings.listed_by_setting.set(previous_member)

result = dict(station=session.stationid, alliance=session.allianceid, labels=[entry.text for entry in options], queries=queries)
