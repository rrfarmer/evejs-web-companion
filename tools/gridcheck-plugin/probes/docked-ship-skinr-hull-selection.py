import evetypes
import shipgroup
import uthread2
from characterdata.races import get_ship_type_id
from cosmetics.client.ships.skins.live_data import current_skin_design
from cosmetics.common.ships.skins.static_data.slot_configuration import SlotConfigurationsDataLoader, is_skinnable_ship
from eve.client.script.ui.cosmetics.ship.const import SkinrPage
from eve.client.script.ui.cosmetics.ship.pages import current_page
from eve.client.script.ui.cosmetics.ship.pages.studio.studioUtil import get_ship_factions
from eve.client.script.ui.cosmetics.ship.shipSKINRWindow import ShipSKINRWindow
from localization import GetByLabel

prefix = 'UI/Personalization/ShipSkins/SKINR/Studio/'
window = ShipSKINRWindow.Open()
try:
    window.studio_page.home_page._on_create_new_design_btn()
    designer = window.studio_page.designer_page
    active = current_skin_design.get_active_ship_type_id()
    default = current_skin_design.get().ship_type_id
    automatically_open = designer.hull_selection_panel is not None
    if not automatically_open:
        designer.on_hull_selection_button()
    picker = designer.hull_selection_panel
    picker.tree_view.apply_search_query('Venture')
    venture = picker.tree_view.root_node.GetChildByID(32880)
    if venture is None:
        raise RuntimeError('Venture missing from native hull search')
    picker.on_hull_type_selected(venture.GetID())
    uthread2.sleep(0.2)
    observation = dict(station=session.stationid, designer=current_page.get_page_id() == SkinrPage.STUDIO_DESIGNER,
                       create=GetByLabel(prefix + 'CreateNewDesign'), picker=GetByLabel(prefix + 'HullSelection'),
                       noComponents=GetByLabel(prefix + 'NoComponentsSelected'),
                       active=active, activeSkinnable=is_skinnable_ship(active), default=default,
                       pickerOpenedAutomatically=automatically_open, selected=current_skin_design.get().ship_type_id,
                       selectedName=evetypes.GetName(venture.GetID()), saveDisabled=designer.save_skin_button.disabled,
                       factions=get_ship_factions(),
                       excluded=sorted(set(SlotConfigurationsDataLoader.get_type_ids_with_empty_slot_configuration())),
                       classOrder=shipgroup.GROUPS_BY_SIZE, subgroups=shipgroup.SUB_GROUPS_BY_SHIP_GROUP,
                       fallbackByRace=dict((str(race), get_ship_type_id(race)) for race in (1, 2, 4, 8)))
finally:
    window.Close()
result = observation
