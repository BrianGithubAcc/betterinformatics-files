import {
  Button,
  Group,
  Modal,
  Select,
  SegmentedControl,
  Stack,
  Switch,
  TextInput,
  Text,
  Tree,
  Anchor,
  Divider,
  TreeNodeData,
  RenderTreeNodePayload,
} from "@mantine/core";
import React, { useMemo, useState } from "react";
import { useCreatePage, useListPages } from "../api/hooks/pages";
import { NavLink, useMatch, useNavigate } from "react-router-dom";
import {
  IconChevronRight,
  IconPlus,
  IconSquarePlus,
} from "@tabler/icons-react";
import style from "./guide-sidebar-left.module.css";
import { clsx } from "clsx";
import { Turnstile } from "@marsidev/react-turnstile";
import { useUser } from "../auth";
import { Kind } from "../api/model";
import serverData from "../utils/server-data";

const LeafNode: React.FC<RenderTreeNodePayload> = ({
  node,
  expanded,
  hasChildren,
  elementProps,
  tree,
}) => {
  const match = useMatch(`/guide/${node.value}`);

  return (
    <Anchor
      display="block"
      component={NavLink}
      to={`/guide/${node.value}`}
      {...elementProps}
      /* Override onCLick from default Tree prop list to only close expansion
         if we are already on the page -- otherwise it is annoying */
      onClick={_ => {
        if (hasChildren && (match || !expanded)) {
          tree.toggleExpanded(node.value);
        }
      }}
      className={clsx(
        style.treeNodeLink,
        match && style.active,
        elementProps.className,
      )}
    >
      <Group gap="xs" justify="space-between">
        <span className={style.ellipsis}>{node.label}</span>
        {hasChildren && (
          <IconChevronRight
            size={16}
            style={{
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.2s",
            }}
          />
        )}
      </Group>
    </Anchor>
  );
};

export const GuideSideBarLeft: React.FC = () => {
  const user = useUser();
  const navigate = useNavigate();
  const [treeMode, setTreeMode] = useState<"main" | "courses">("main");

  const { data: pages, refetch: refetchPages } = useListPages();

  const visiblePages = useMemo(
    () =>
      pages?.pages.filter(page =>
        treeMode === "main"
          ? page.categories.length === 0
          : page.categories.length > 0,
      ) ?? [],
    [pages, treeMode],
  );

  const treeData = useMemo(() => {
    // Build a tree from the flat list of pages and their single parent.
    const pageMap: Record<string, { parent: string | null } & TreeNodeData> =
      {};
    visiblePages.forEach(page => {
      pageMap[page.slug] = {
        value: page.slug,
        label: page.title,
        children: undefined,
        parent: page.parent,
      };
    });
    visiblePages.forEach(page => {
      if (!page.parent) return;
      const parentNode = pageMap[page.parent];
      if (!parentNode) return;
      parentNode.children ??= [];
      parentNode.children.push(pageMap[page.slug]);
    });
    return Object.values(pageMap)
      .filter(node => !node.parent || !Object.hasOwn(pageMap, node.parent))
      .map(node => {
        const { parent: _parent, ...rest } = node;
        return rest;
      });
  }, [visiblePages]);

  const [isOpen, setIsOpen] = useState(false);
  const [newPageName, setNewPageName] = useState("");
  const [newPageParent, setNewPageParent] = useState<string | null>(null);
  const [newPageKind, setNewPageKind] = useState<Kind>("guide");
  const [newPageAnonymous, setNewPageAnonymous] = useState(false);

  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  const {
    mutate: createPage,
    isPending: createIsPending,
    isError: createIsError,
  } = useCreatePage({
    mutation: {
      onSuccess(data) {
        setIsOpen(false);
        setNewPageName("");
        setNewPageParent(null);
        setNewPageAnonymous(false);
        void refetchPages();
        void navigate(`/guide/${data.slug}`);
      },
    },
    request: {
      method: "POST",
      headers: {
        "X-Turnstile-Token": turnstileToken ?? "",
      },
    },
  });
  return (
    <>
      <Modal
        opened={isOpen}
        title="Create New Page"
        onClose={() => setIsOpen(false)}
      >
        <Stack>
          {createIsError && <Text c="red">Page could not be created.</Text>}
          <TextInput
            label="Page Name"
            placeholder="Guide to Edinburgh"
            value={newPageName}
            onChange={e => setNewPageName(e.currentTarget.value)}
          />
          <Select
            label="Parent Page"
            placeholder="No parent"
            clearable
            searchable
            data={pages?.pages.map(p => ({ value: p.slug, label: p.title }))}
            value={newPageParent}
            onChange={setNewPageParent}
          />
          <Group justify="space-between">
            <Switch
              label="Create Anonymously"
              checked={newPageAnonymous}
              onChange={() => setNewPageAnonymous(!newPageAnonymous)}
            />
            {user?.isAdmin && (
              <Switch
                label="Create Static HTML Page"
                checked={newPageKind === "static_html"}
                onChange={() =>
                  setNewPageKind(
                    newPageKind === "static_html" ? "guide" : "static_html",
                  )
                }
              />
            )}
          </Group>
          <Button
            disabled={createIsPending || newPageName.trim() === ""}
            onClick={() =>
              createPage({
                data: {
                  kind: newPageKind,
                  title: newPageName,
                  parent: newPageParent,
                  categories: [],
                  is_anonymous: newPageAnonymous,
                },
              })
            }
            leftSection={<IconPlus />}
            loading={createIsPending || (!user?.isAdmin && !turnstileToken)}
          >
            Add
          </Button>
          {!user?.isAdmin && (
            <Turnstile
              siteKey={serverData.turnstile_sitekey}
              onSuccess={setTurnstileToken}
              options={{
                action: "create_page",
              }}
            />
          )}
        </Stack>
      </Modal>
      <Stack
        gap="xs"
        pos={{ base: "relative", sm: "sticky" }}
        miw="200px"
        top={{ base: 0, sm: "4rem" }}
        w={{ base: "100%", sm: "auto" }}
      >
        <SegmentedControl
          fullWidth
          aria-label="Guide navigation"
          value={treeMode}
          onChange={value => setTreeMode(value as "main" | "courses")}
          data={[
            { label: "Main", value: "main" },
            { label: "Courses", value: "courses" },
          ]}
        />
        <Tree
          data={treeData}
          renderNode={payload => <LeafNode {...payload} />}
          classNames={{
            root: style.treeRoot,
            label: style.treeNodeLabel,
            subtree: style.treeSubtree,
          }}
        />
        <Divider my="md" />
        <Button
          onClick={() => setIsOpen(true)}
          size="compact-sm"
          variant="subtle"
          leftSection={<IconSquarePlus size={16} />}
          justify="flex-start"
        >
          Create New Page
        </Button>
      </Stack>
    </>
  );
};
