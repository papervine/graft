"""Pagination.

The shape here is a deliberate departure from the TypeScript runtime, and the difference is the
point: TypeScript returns one object that is both `AsyncIterable` and `PromiseLike`, so `for await`
walks items and `await` gives a page. Python has no equivalent overload, so a page **is** an
iterable of its items and `.pages()` walks envelopes:

    for widget in client.widgets.list():        # every widget, across pages
        ...

    for page in client.widgets.list().pages():  # one envelope at a time
        print(page.total)

Iterating items by default is the right default for Python because it is what every stdlib and
third-party iterable does; a caller who wanted pages asks for them.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Generic, TypeVar

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable, Coroutine, Iterator, Mapping, Sequence

__all__ = ["AsyncPage", "AsyncPaginator", "Page", "PageInfo", "Paginator"]

T = TypeVar("T")


class PageInfo:
    """How to request the next page, or ``None`` when there is not one."""

    __slots__ = ("params",)

    def __init__(self, params: Mapping[str, object]) -> None:
        self.params = dict(params)


class Page(Generic[T]):
    """One page of results, plus whatever the envelope carried."""

    def __init__(
        self,
        *,
        items: Sequence[T],
        total: int | None = None,
        next_cursor: str | None = None,
        has_more: bool | None = None,
        raw: object = None,
    ) -> None:
        self.items = list(items)
        self.total = total
        self.next_cursor = next_cursor
        self._has_more = has_more
        self.raw = raw

    @property
    def has_next_page(self) -> bool:
        """Whether another page exists.

        Prefers what the server said. Falling back to "the page was not empty" is deliberate but
        weaker: it costs one extra request at the end of a full walk, which is far better than
        stopping early on an API that returns a short-but-not-final page.
        """
        if self._has_more is not None:
            return self._has_more
        if self.next_cursor is not None:
            return self.next_cursor != ""
        return len(self.items) > 0

    def __iter__(self) -> Iterator[T]:
        return iter(self.items)

    def __len__(self) -> int:
        return len(self.items)

    def __bool__(self) -> bool:
        return bool(self.items)

    def __repr__(self) -> str:
        return (
            f"Page(items={len(self.items)}, total={self.total!r}, "
            f"has_next_page={self.has_next_page})"
        )


class Paginator(Generic[T]):
    """Lazily walks pages, yielding items.

    Nothing is requested until iteration begins, so building one is free and a caller who only wants
    ``.pages()`` has not already paid for a fetch.
    """

    def __init__(
        self,
        fetch: Callable[[Mapping[str, object]], Page[T]],
        *,
        initial: Mapping[str, object] | None = None,
        advance: Callable[[Page[T], Mapping[str, object]], Mapping[str, object] | None],
    ) -> None:
        self._fetch = fetch
        self._initial = dict(initial or {})
        self._advance = advance

    def pages(self) -> Iterator[Page[T]]:
        params: Mapping[str, object] | None = self._initial
        while params is not None:
            page = self._fetch(params)
            yield page
            if not page.has_next_page:
                return
            params = self._advance(page, params)

    def __iter__(self) -> Iterator[T]:
        for page in self.pages():
            yield from page.items

    def first_page(self) -> Page[T]:
        """The first page, for callers who want the envelope and nothing more."""
        return self._fetch(self._initial)


class AsyncPage(Page[T]):
    """One page from an async client. Identical envelope, so it simply reuses :class:`Page`."""

    def __aiter__(self) -> AsyncIterator[T]:
        return self._aiter()

    async def _aiter(self) -> AsyncIterator[T]:
        for item in self.items:
            yield item


class AsyncPaginator(Generic[T]):
    """The async twin of :class:`Paginator`."""

    def __init__(
        self,
        fetch: Callable[[Mapping[str, object]], Coroutine[object, object, AsyncPage[T]]],
        *,
        initial: Mapping[str, object] | None = None,
        advance: Callable[[AsyncPage[T], Mapping[str, object]], Mapping[str, object] | None],
    ) -> None:
        self._fetch = fetch
        self._initial = dict(initial or {})
        self._advance = advance

    async def pages(self) -> AsyncIterator[AsyncPage[T]]:
        params: Mapping[str, object] | None = self._initial
        while params is not None:
            page = await self._fetch(params)
            yield page
            if not page.has_next_page:
                return
            params = self._advance(page, params)

    async def __aiter__(self) -> AsyncIterator[T]:
        async for page in self.pages():
            for item in page.items:
                yield item

    async def first_page(self) -> AsyncPage[T]:
        return await self._fetch(self._initial)


def advance_offset(
    limit_param: str, offset_param: str
) -> Callable[[Page[T], Mapping[str, object]], Mapping[str, object] | None]:
    """Advance an offset scheme.

    The parameter order here is the whole bug the TypeScript runtime shipped once: the caller's
    original params must be spread **first** and the computed offset **last**, or a caller who
    passed ``offset=0`` explicitly overwrites the computed value and every page after the first
    refetches page one — an infinite iterator of duplicates. Written as an explicit dict build
    rather than a merge so the ordering cannot be reversed by accident.
    """

    def advance(page: Page[T], params: Mapping[str, object]) -> Mapping[str, object] | None:
        previous = params.get(offset_param)
        current = previous if isinstance(previous, int) else 0
        limit_value = params.get(limit_param)
        step = limit_value if isinstance(limit_value, int) and limit_value > 0 else len(page.items)
        if step <= 0:
            return None
        nxt = dict(params)
        nxt[offset_param] = current + step
        return nxt

    return advance


def advance_page_number(
    page_param: str,
) -> Callable[[Page[T], Mapping[str, object]], Mapping[str, object] | None]:
    """Advance a page-number scheme."""

    def advance(page: Page[T], params: Mapping[str, object]) -> Mapping[str, object] | None:
        previous = params.get(page_param)
        current = previous if isinstance(previous, int) else 1
        nxt = dict(params)
        nxt[page_param] = current + 1
        return nxt

    return advance


def advance_cursor(
    cursor_param: str,
) -> Callable[[Page[T], Mapping[str, object]], Mapping[str, object] | None]:
    """Advance a cursor scheme.

    Returns ``None`` on a missing cursor rather than resending the previous one: an API that says
    "there are more" but supplies no cursor is broken, and looping forever on its behalf turns a
    server bug into a hung client.
    """

    def advance(page: Page[T], params: Mapping[str, object]) -> Mapping[str, object] | None:
        if page.next_cursor is None or page.next_cursor == "":
            return None
        nxt = dict(params)
        nxt[cursor_param] = page.next_cursor
        return nxt

    return advance
