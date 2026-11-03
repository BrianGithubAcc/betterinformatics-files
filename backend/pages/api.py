import datetime

import diff_match_patch as dmp_module
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from ninja import Router, Schema
from ninja.decorators import decorate_view

from backend import settings
from categories.models import Category
from dissertations.api import SlugDisplayNameSchema
from ediauth import auth_check
from pages.models import Page, PageAuthor, PageRevision
from util.response import ErrorSchema, not_allowed, not_possible

router = Router(tags=["Pages"])


class PageAuthorResponse(Schema):
    display_name: str
    anonymised: bool
    username: str | None


class PageResponse(Schema):
    title: str
    slug: str
    kind: Page.Kind
    categories: list[SlugDisplayNameSchema]
    parent: str | None
    created_at: datetime.datetime
    edited_at: datetime.datetime
    content: str
    author: PageAuthorResponse
    revision_count: int


class PageListResponseItem(Schema):
    title: str
    slug: str
    kind: Page.Kind
    categories: list[SlugDisplayNameSchema]
    parent: str | None
    created_at: datetime.datetime
    edited_at: datetime.datetime


class PageListResponse(Schema):
    pages: list[PageListResponseItem]


class PageCreateResponse(Schema):
    slug: str


class PageUpdateResponse(Schema):
    slug: str


class PageRevisionResponseItem(Schema):
    id: int
    created_at: datetime.datetime
    author: PageAuthorResponse
    message: str
    content_delta: str
    title_delta: str
    redacted: bool


class PageRevisionResponse(Schema):
    id: int
    created_at: datetime.datetime
    author: PageAuthorResponse
    message: str
    content_delta: str
    title_delta: str
    content: str
    title: str
    redacted: bool


class PageRevisionListResponse(Schema):
    revisions: list[PageRevisionResponseItem]


def get_page_author_response(
    author: PageAuthor, anonymised: bool, request: HttpRequest
) -> PageAuthorResponse:
    # Do not reveal the author (i.e. student ID) to users not logged in for
    # safety and privacy reasons
    if not request.user:
        return PageAuthorResponse(
            display_name="Hidden",
            anonymised=True,
            username=None,
        )

    anonymise_to_requester = (
        anonymised
        and not auth_check.has_admin_rights(request)
        and author.user != request.user
    )

    if anonymise_to_requester:
        display_name = "Anonymous"
    elif author.user:
        display_name = author.user.profile.display_username
    elif author.temp_user:
        display_name = f"Temporary User {author.temp_user.session_id}"
    else:
        display_name = "Deleted User"

    return PageAuthorResponse(
        display_name=display_name,
        anonymised=anonymised,
        username="anonymous"
        if anonymise_to_requester
        else author.user.username
        if author.user
        else None,
    )


def get_page_author(request) -> PageAuthor:
    if request.user:
        author, _created = PageAuthor.objects.get_or_create(user=request.user)
    elif request.temp_user:
        author, _created = PageAuthor.objects.get_or_create(temp_user=request.temp_user)
    else:
        raise ValueError("No user or temp user found in request")
    return author


@router.get(
    "/", response={200: PageListResponse, 404: ErrorSchema}, operation_id="listPages"
)
def list_pages(
    request,
    child_of: str | None = None,
    category: str | None = None,
):
    query = Page.objects.all()

    if child_of and child_of != "":
        parent_page = get_object_or_404(Page, slug=child_of)
        query = query.filter(parent=parent_page)
    elif child_of == "":
        query = query.filter(parent=None)

    if category and category != "":
        category_obj = get_object_or_404(Category, slug=category)
        query = query.filter(categories=category_obj)
    elif category == "":
        query = query.filter(categories=None)

    pages = (
        query.select_related("author", "parent", "categories")
        .order_by("title")
    )

    page_list = []
    for page in pages:
        page_list.append(
            {
                "title": page.title,
                "slug": page.slug,
                "kind": page.kind,
                "categories": [
                    SlugDisplayNameSchema(slug=cat.slug, displayname=cat.displayname)
                    for cat in page.categories.all()
                ],
                "parent": page.parent.slug if page.parent else None,
                "created_at": page.created_at.isoformat(),
                "edited_at": page.edited_at.isoformat(),
                "author": get_page_author_response(
                    page.author, page.anonymised, request
                ),
            }
        )
    return {"pages": page_list}


@router.get(
    "/{slug}", operation_id="getPage", response={200: PageResponse, 404: ErrorSchema}
)
def get_page(request, slug: str):
    page = get_object_or_404(Page, slug=slug)
    return PageResponse(
        title=page.title,
        slug=page.slug,
        kind=Page.Kind(page.kind),
        categories=[
            SlugDisplayNameSchema(slug=cat.slug, displayname=cat.displayname)
            for cat in page.categories.all()
        ],
        parent=page.parent.slug if page.parent else None,
        created_at=page.created_at,
        edited_at=page.edited_at,
        content=page.content,
        author=get_page_author_response(page.author, page.anonymised, request),
        revision_count=page.revisions.count(),
    )


class PageCreateRequest(Schema):
    kind: Page.Kind
    title: str
    categories: list[str]
    parent: str | None = None
    is_anonymous: bool


def create_page_slug(title: str):
    """
    Create a valid and unique slug for the page title
    :param title: page title
    """
    oslug = "".join(
        filter(
            lambda x: x in settings.COMSOL_DOCUMENT_SLUG_CHARS,
            title.lower().replace(" ", "_"),
        )
    )
    if oslug == "":
        oslug = "invalid_name"

    def exists(aslug):
        return Page.objects.filter(slug=aslug).exists()

    slug = oslug
    cnt = 0
    while exists(slug):
        slug = oslug + "-" + str(cnt)
        cnt += 1

    return slug


def calculate_patch(old_content: str, new_content: str) -> str:
    dmp = dmp_module.diff_match_patch()
    (oldChars, newChars, lines) = dmp.diff_linesToChars(old_content, new_content)
    diffs = dmp.diff_main(oldChars, newChars, False)
    dmp.diff_charsToLines(diffs, lines)
    dmp.diff_cleanupSemantic(diffs)

    patch = dmp.patch_make(diffs)
    return dmp.patch_toText(patch)


def patch_to_standard_diff(patch_text: str) -> str:
    dmp = dmp_module.diff_match_patch()
    patches = dmp.patch_fromText(patch_text)
    diffs = []
    for patch in patches:
        diffs.extend(patch.diffs)

    formatted_lines = []
    for op, text in diffs:
        if op == dmp.DIFF_INSERT:
            for text_line in text.splitlines():
                formatted_lines.append(f"+ {text_line}")
        elif op == dmp.DIFF_DELETE:
            for text_line in text.splitlines():
                formatted_lines.append(f"- {text_line}")
        else:
            for text_line in text.splitlines():
                formatted_lines.append(f"  {text_line}")

    return "\n".join(formatted_lines)


def create_page_nochecks(
    title: str,
    kind: Page.Kind,
    categories: list[Category],
    author: PageAuthor,
    parent: Page | None,
    is_anonymous: bool,
    slug: str | None = None,
) -> Page:
    page = Page(
        title=title,
        slug=create_page_slug(title if slug is None else slug),
        kind=kind,
        parent=parent,
        author=author,
        anonymised=is_anonymous,
        content="",
    )
    page.save()

    page.categories.set(categories)

    content_patch = calculate_patch("", page.content)
    title_patch = calculate_patch("", page.title)

    PageRevision.objects.create(
        page=page,
        author=author,
        anonymised=is_anonymous,
        content_delta=content_patch,
        title_delta=title_patch,
        message="Created empty page",
    )

    return page


@router.post(
    "/",
    response={
        201: PageCreateResponse,
        400: ErrorSchema,
        403: ErrorSchema,
    },
    operation_id="createPage",
)
@decorate_view(auth_check.supports_temp_user)
def create_page(request, data: PageCreateRequest):
    # Only admins can assign categories to guide pages.
    if data.categories and not auth_check.has_admin_rights(request):
        return not_allowed()

    # Only admins can create static_html pages since they can contain JS
    if data.kind == Page.Kind.STATIC_HTML and not auth_check.has_admin_rights(request):
        return not_allowed()

    # Double check category exists
    categories = list(Category.objects.filter(slug__in=set(data.categories)))
    if len(categories) != len(set(data.categories)):
        found = {category.slug for category in categories}
        missing = next(slug for slug in data.categories if slug not in found)
        return not_possible(f"Category {missing} does not exist")

    # Double check parents exists
    parent = None
    if data.parent:
        try:
            parent = Page.objects.get(slug=data.parent)
        except Page.DoesNotExist:
            return not_possible(f"Parent page {data.parent} does not exist")

    page = create_page_nochecks(
        title=data.title,
        kind=data.kind,
        categories=categories,
        author=get_page_author(request),
        parent=parent,
        is_anonymous=data.is_anonymous,
    )

    return 201, {"slug": page.slug}


class PageUpdateRequest(Schema):
    slug: str
    title: str | None
    categories: list[str]
    parent: str | None
    content: str | None
    revision_message: str
    is_anonymous: bool


@router.put(
    "/{slug}",
    response={
        200: PageUpdateResponse,
        403: ErrorSchema,
        400: ErrorSchema,
        404: ErrorSchema,
    },
    operation_id="updatePage",
)
@decorate_view(auth_check.supports_temp_user)
def update_page(request, slug: str, data: PageUpdateRequest):
    page = get_object_or_404(Page, slug=slug)
    author = get_page_author(request)

    # Only admins and owners can change the slug or update parents
    if (
        (
            slug != data.slug
            or data.parent != (page.parent.slug if page.parent else None)
        )
        and not auth_check.has_admin_rights(request)
        and page.author != author
    ):
        return not_allowed()

    # Only admins can edit static_html pages since they can contain JS
    if page.kind == Page.Kind.STATIC_HTML and not auth_check.has_admin_rights(request):
        return not_allowed()

    # Only admins can change or assign a category - since they are category pages
    new_categories = set(data.categories)
    old_categories = set(page.categories.values_list("slug", flat=True))
    if new_categories != old_categories:
        if not auth_check.has_admin_rights(request):
            return not_allowed()

    # If None, allow keeping existing title or content
    # These are the only fields that are allowed to be partially updated -
    # they are for situations when we only want to update metadata.
    if data.title is None:
        data.title = page.title
    if data.content is None:
        data.content = page.content

    title_patch = calculate_patch(page.title, data.title)
    content_patch = calculate_patch(page.content, data.content)

    if (
        slug == data.slug
        and title_patch == ""
        and content_patch == ""
        and data.parent == (page.parent.slug if page.parent else None)
        and new_categories == old_categories
    ):
        return not_possible("No changes detected")

    page.slug = data.slug

    categories = list(Category.objects.filter(slug__in=new_categories))
    if len(categories) != len(new_categories):
        found = {category.slug for category in categories}
        missing = next(slug for slug in data.categories if slug not in found)
        return not_possible(f"Category {missing} does not exist")

    page.title = data.title
    page.content = data.content

    # Update parents
    parent = None
    if data.parent:
        try:
            parent = Page.objects.get(slug=data.parent)
        except Page.DoesNotExist:
            return not_possible(f"Parent page {data.parent} does not exist")

        if parent.pk == page.pk:
            return not_possible("A page cannot be its own parent")

        ancestor = parent
        seen_ancestors = set()
        while ancestor:
            if ancestor.pk == page.pk:
                return not_possible("This parent would create a page cycle")
            if ancestor.pk in seen_ancestors:
                return not_possible("The existing page hierarchy contains a cycle")
            seen_ancestors.add(ancestor.pk)
            ancestor = ancestor.parent

    page.parent = parent
    page.categories.set(categories)

    page.edited_at = datetime.datetime.now(datetime.UTC)
    page.save()

    # Create new revision
    PageRevision.objects.create(
        page=page,
        author=author,
        anonymised=data.is_anonymous,
        content_delta=content_patch,
        title_delta=title_patch,
        message=data.revision_message,
    )

    return {"slug": page.slug}


@router.get(
    "/{slug}/revisions/",
    response={200: PageRevisionListResponse, 404: ErrorSchema},
    operation_id="listRevisions",
)
@auth_check.require_login
def list_revisions(request, slug: str):
    page = get_object_or_404(Page, slug=slug)
    revisions = page.revisions.select_related("author").all().order_by("-created_at")

    can_see_redacted = auth_check.has_admin_rights(request)

    revision_list = []
    for rev in revisions:
        revision_list.append(
            {
                "id": rev.id,
                "created_at": rev.created_at.isoformat(),
                "author": get_page_author_response(rev.author, rev.anonymised, request),
                "message": "Redacted Revision"
                if rev.redacted and not can_see_redacted
                else rev.message,
                "content_delta": ""
                if rev.redacted and not can_see_redacted
                else patch_to_standard_diff(rev.content_delta),
                "title_delta": ""
                if rev.redacted and not can_see_redacted
                else patch_to_standard_diff(rev.title_delta),
                "redacted": rev.redacted,
            }
        )

    return {"revisions": revision_list}


class UpdateRevisionRequest(Schema):
    redacted: bool


@router.patch(
    "/{slug}/revisions/{revision_id}",
    response={204: None, 403: ErrorSchema, 404: ErrorSchema},
    operation_id="redactRevision",
)
@auth_check.require_admin
def redact_revision(request, slug: str, revision_id: int, data: UpdateRevisionRequest):
    page = get_object_or_404(Page, slug=slug)
    revision = get_object_or_404(PageRevision, id=revision_id, page=page)

    revision.redacted = data.redacted
    revision.save()

    return 204, None


@router.post(
    "/{slug}/revisions/{revision_id}/restore",
    response={204: None, 403: ErrorSchema, 404: ErrorSchema},
    operation_id="restoreRevision",
)
@auth_check.require_admin
def restore_revision(request, slug: str, revision_id: int):
    page = get_object_or_404(Page, slug=slug)
    revision = get_object_or_404(PageRevision, id=revision_id, page=page)
    author = get_page_author(request)

    # Can't restore current revision
    if revision == page.revisions.order_by("-created_at").first():
        return not_possible("Cannot restore the current revision")

    # Restore the content and title of the page to the state of the revision
    recreated_content = ""
    recreated_title = ""
    all_previous_revisions = PageRevision.objects.filter(page=page, id__lte=revision.id)

    dmp = dmp_module.diff_match_patch()
    for rev in all_previous_revisions:
        recreated_content = dmp.patch_apply(
            dmp.patch_fromText(rev.content_delta), recreated_content
        )[0]
        recreated_title = dmp.patch_apply(
            dmp.patch_fromText(rev.title_delta), recreated_title
        )[0]

    content_delta = calculate_patch(page.content, recreated_content)
    title_delta = calculate_patch(page.title, recreated_title)

    page.content = recreated_content
    page.title = recreated_title
    page.edited_at = datetime.datetime.now(datetime.UTC)
    page.save()

    # Create new revision
    PageRevision.objects.create(
        page=page,
        author=author,
        anonymised=False,
        content_delta=content_delta,
        title_delta=title_delta,
        message=f"Restored to revision {revision.id}",
    )

    return 204, None


@router.get(
    "/{slug}/revisions/{revision_id}",
    response={200: PageRevisionResponse, 403: ErrorSchema, 404: ErrorSchema},
    operation_id="getRevision",
)
def get_revision(request, slug: str, revision_id: int):
    page = get_object_or_404(Page, slug=slug)
    revision = get_object_or_404(PageRevision, id=revision_id, page=page)

    can_see_redacted = auth_check.has_admin_rights(request)

    if revision.redacted and not can_see_redacted:
        recreated_content = ""
        recreated_title = ""
    else:
        all_previous_revisions = PageRevision.objects.filter(
            page=page, id__lte=revision.id
        )

        dmp = dmp_module.diff_match_patch()
        recreated_content = ""
        recreated_title = ""
        for rev in all_previous_revisions:
            recreated_content = dmp.patch_apply(
                dmp.patch_fromText(rev.content_delta), recreated_content
            )[0]
            recreated_title = dmp.patch_apply(
                dmp.patch_fromText(rev.title_delta), recreated_title
            )[0]

    return {
        "id": revision.id,
        "created_at": revision.created_at.isoformat(),
        "author": get_page_author_response(
            revision.author, revision.anonymised, request
        ),
        "message": revision.message,
        "content_delta": ""
        if revision.redacted and not can_see_redacted
        else patch_to_standard_diff(revision.content_delta),
        "title_delta": ""
        if revision.redacted and not can_see_redacted
        else patch_to_standard_diff(revision.title_delta),
        "content": ""
        if revision.redacted and not can_see_redacted
        else recreated_content,
        "title": "" if revision.redacted and not can_see_redacted else recreated_title,
        "redacted": revision.redacted,
    }


@router.delete(
    "/{slug}",
    response={204: None, 403: ErrorSchema, 404: ErrorSchema},
    operation_id="deletePage",
)
@decorate_view(auth_check.supports_temp_user)
def delete_page(request, slug: str):
    page = get_object_or_404(Page, slug=slug)

    if not auth_check.has_admin_rights(request) and (
        page.kind == "static_html" or page.author != get_page_author(request)
    ):
        return not_allowed()

    # SET_NULL makes children of this page top-level automatically.
    page.delete()

    return 204, None
