from expertSystems.data import get_expert_systems, get_associated_expert_systems
from expertSystems.client.ui.icon import associated
from expertSystems.client.service import ExpertSystemService
from expertSystems.feature_flag import is_expert_systems_enabled


def observe():
    ships = sorted(set(ship for system in get_expert_systems()
                       for ship in system.associated_type_ids))
    installed = ExpertSystemService.instance().GetMyExpertSystems()
    live = {}
    for ship in ships:
        controller = associated.Controller.__new__(associated.Controller)
        controller.type_id = ship
        live[str(ship)] = {
            'state': controller._get_new_state(),
            'systems': sorted(system.type_id for system in get_associated_expert_systems(ship))}

    # Exercise the native controller's alternate branches without changing pilot data.
    controller.type_id = ships[0]
    system = get_associated_expert_systems(ships[0])[0].type_id
    prior_benefit = associated.expert_system_benefits_player
    service = ExpertSystemService.instance()
    prior_installed = service.GetMyExpertSystems
    try:
        associated.expert_system_benefits_player = lambda unused: True
        service.GetMyExpertSystems = lambda: {}
        available = controller._get_new_state()
        service.GetMyExpertSystems = lambda: {system: None}
        active = controller._get_new_state()
        associated.expert_system_benefits_player = lambda unused: False
        hidden = controller._get_new_state()
    finally:
        service.GetMyExpertSystems = prior_installed
        associated.expert_system_benefits_player = prior_benefit
    return {'station': session.stationid, 'enabled': is_expert_systems_enabled(),
            'installed': sorted(installed.keys()), 'ships': live,
            'sample': ships[0], 'branches': [available, active, hidden]}


result = observe()
