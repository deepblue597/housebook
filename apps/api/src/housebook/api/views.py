"""IndexedItem -> response models."""

from datetime import date
from urllib.parse import quote

from housebook.api.schemas import AttachmentOut, ItemDetailOut, ItemFieldsOut, ItemOut, LocationOut
from housebook.config import Settings
from housebook.domain.status import Status, compute_status
from housebook.services.indexer import IndexedItem, display_name


def item_status(item: IndexedItem, today: date) -> Status:
    f = item.fields
    return compute_status(
        today,
        next_check=f.next_check,
        warranty_until=f.warranty_until,
        check_every=f.check_every,
        last_service=item.last_service,
        purchased=f.purchased,
    )


def obsidian_url(settings: Settings, rel: str) -> str | None:
    """obsidian://open needs the path relative to the vault root (DESIGN 15.16)."""
    if not settings.obsidian_vault:
        return None
    path = f"{settings.obsidian_vault_subpath}/{rel}" if settings.obsidian_vault_subpath else rel
    return f"obsidian://open?vault={quote(settings.obsidian_vault, safe='')}&file={quote(path, safe='')}"


def item_out(item: IndexedItem, today: date, settings: Settings, *, body: bool = False) -> ItemOut:
    f = item.fields
    t = item.item_type
    loc = item.location
    data = dict(
        id=item.id,
        path=item.rel,
        etag=item.hash,
        name=display_name(item),
        type=t.key if t else f.type,
        type_known=t is not None,
        critical=f.critical if f.critical is not None else bool(t and t.critical),
        fields=ItemFieldsOut(
            **f.model_dump(exclude={"housebook_id", "check_every"}),
            check_every=str(f.check_every) if f.check_every else None,
        ),
        frontmatter=item.raw,
        status=item_status(item, today),
        location=LocationOut(floor_id=loc.floor_id, room_id=loc.room_id, x=loc.x, y=loc.y, rotation=loc.rotation)
        if loc
        else None,
        error_codes=list(item.error_codes),
        attachments=[
            AttachmentOut(
                name=a.name,
                size=a.size,
                listed=a.listed,
                url=f"/api/items/{quote(item.id, safe='')}/attachments/{quote(a.name, safe='')}",
            )
            for a in item.attachments
        ],
        stale=item.stale,
        parse_error=item.parse_error,
        obsidian_url=obsidian_url(settings, item.rel),
    )
    return ItemDetailOut(**data, body=item.body) if body else ItemOut(**data)
