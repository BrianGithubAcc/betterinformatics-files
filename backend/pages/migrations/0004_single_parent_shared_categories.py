from django.db import migrations, models
import django.db.models.deletion


def move_page_relationships(apps, schema_editor):
    Page = apps.get_model("pages", "Page")
    PageParent = apps.get_model("pages", "PageParent")

    # Preserve the existing category association as one entry in the new
    # many-to-many relationship.
    for page in Page.objects.exclude(category__isnull=True).iterator():
        page.categories.add(page.category_id)

    # Keep the first existing parent by sibling order. Skip any edge that
    # would retain a cycle in the new single-parent hierarchy.
    parent_for_child = {}
    links = (
        PageParent.objects.filter(parent__isnull=False)
        .order_by("order", "id")
        .values_list("child_id", "parent_id")
    )
    for child_id, parent_id in links.iterator():
        if child_id in parent_for_child:
            continue
        ancestor_id = parent_id
        seen = set()
        while ancestor_id is not None and ancestor_id not in seen:
            if ancestor_id == child_id:
                break
            seen.add(ancestor_id)
            ancestor_id = parent_for_child.get(ancestor_id)
        else:
            parent_for_child[child_id] = parent_id

    for child_id, parent_id in parent_for_child.items():
        Page.objects.filter(pk=child_id).update(parent_id=parent_id)


def restore_page_relationships(apps, schema_editor):
    Page = apps.get_model("pages", "Page")
    PageParent = apps.get_model("pages", "PageParent")

    category_owners = {}
    for page in Page.objects.all().iterator():
        category_ids = list(page.categories.values_list("id", flat=True))
        if len(category_ids) > 1:
            raise RuntimeError(
                "Cannot reverse the guide relationship migration: a page has "
                "multiple categories. Remove extra category links first."
            )
        if category_ids:
            category_id = category_ids[0]
            if category_id in category_owners:
                raise RuntimeError(
                    "Cannot reverse the guide relationship migration: a category "
                    "is shared by multiple pages. Remove the shared association "
                    "first."
                )
            category_owners[category_id] = page.pk
            Page.objects.filter(pk=page.pk).update(category_id=category_id)

        PageParent.objects.create(
            child_id=page.pk,
            parent_id=page.parent_id,
            order=0,
        )


class Migration(migrations.Migration):
    dependencies = [("pages", "0003_create_page_for_categories")]

    operations = [
        migrations.AddField(
            model_name="page",
            name="parent",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="children",
                to="pages.page",
            ),
        ),
        migrations.AddField(
            model_name="page",
            name="categories",
            field=models.ManyToManyField(
                blank=True,
                related_name="pages",
                to="categories.category",
            ),
        ),
        migrations.RunPython(
            move_page_relationships,
            reverse_code=restore_page_relationships,
        ),
        migrations.RemoveField(model_name="page", name="parents"),
        migrations.DeleteModel(name="PageParent"),
        migrations.RemoveField(model_name="page", name="category"),
    ]
