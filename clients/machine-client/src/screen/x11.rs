use super::probe::x11::Connection as RustConnection;
use x11rb::{
    connection::Connection,
    protocol::xproto::{AtomEnum, ConnectionExt, GetImageReply, ImageFormat, ImageOrder},
};

use super::{x11_pixels, Display, Fault, Source, Window};

pub struct Native {
    connection: std::sync::Mutex<RustConnection>,
    screen: usize,
    pub authority: Option<String>,
}

impl Native {
    pub fn open(display: Option<&str>) -> Result<Self, Fault> {
        let display = display.ok_or(Fault::Absent)?;
        let (connection, screen, authority) = super::probe::x11::selected(display)
            .map_err(|error| Fault::Failed(error.to_string()))?;
        Ok(Self {
            connection: std::sync::Mutex::new(connection),
            screen,
            authority,
        })
    }
    fn root(&self, connection: &RustConnection) -> Result<u32, Fault> {
        connection
            .setup()
            .roots
            .get(self.screen)
            .map(|screen| screen.root)
            .ok_or(Fault::DisplayNotFound)
    }
}

fn failed(error: impl std::fmt::Display) -> Fault {
    Fault::Failed(error.to_string())
}

fn pixels(
    connection: &RustConnection,
    image: &GetImageReply,
    output: &mut Vec<u8>,
    width: u16,
    height: u16,
) -> Result<(u32, u32), Fault> {
    let setup = connection.setup();
    let format = setup
        .pixmap_formats
        .iter()
        .find(|format| format.depth == image.depth)
        .ok_or_else(|| Fault::Failed("missing X11 pixmap format".into()))?;
    let visual = setup
        .roots
        .iter()
        .flat_map(|screen| &screen.allowed_depths)
        .flat_map(|depth| &depth.visuals)
        .find(|visual| visual.visual_id == image.visual)
        .ok_or_else(|| Fault::Failed("missing X11 visual".into()))?;
    x11_pixels::rgba(
        &image.data,
        output,
        width,
        height,
        &x11_pixels::Format {
            bits_per_pixel: format.bits_per_pixel,
            scanline_pad: format.scanline_pad,
            little_endian: setup.image_byte_order == ImageOrder::LSB_FIRST,
            masks: [visual.red_mask, visual.green_mask, visual.blue_mask],
        },
    )
}

fn atom(connection: &RustConnection, name: &[u8]) -> Result<u32, Fault> {
    Ok(connection
        .intern_atom(false, name)
        .map_err(failed)?
        .reply()
        .map_err(failed)?
        .atom)
}

fn frame(connection: &RustConnection, root: u32, id: u32) -> Result<(i32, i32, u32, u32), Fault> {
    let geometry = connection
        .get_geometry(id)
        .map_err(failed)?
        .reply()
        .map_err(failed)?;
    let position = connection
        .translate_coordinates(id, root, 0, 0)
        .map_err(failed)?
        .reply()
        .map_err(failed)?;
    Ok((
        i32::from(position.dst_x),
        i32::from(position.dst_y),
        u32::from(geometry.width),
        u32::from(geometry.height),
    ))
}

fn window(
    connection: &RustConnection,
    root: u32,
    title: u32,
    pid_atom: u32,
    id: u32,
) -> Result<Window, Fault> {
    let (x, y, width, height) = frame(connection, root, id)?;
    let name = connection
        .get_property(false, id, title, AtomEnum::ANY, 0, 64)
        .map_err(failed)?
        .reply()
        .map_err(failed)?;
    let pid = connection
        .get_property(false, id, pid_atom, AtomEnum::CARDINAL, 0, 1)
        .map_err(failed)?
        .reply()
        .map_err(failed)?
        .value32()
        .and_then(|mut values| values.next());
    let app = pid
        .and_then(|pid| std::fs::read_link(format!("/proc/{pid}/exe")).ok())
        .map(|path| super::ax::AppIdentity {
            bundle_id: None,
            path: path.to_string_lossy().into_owned(),
        });
    Ok(Window {
        id,
        display: 0,
        title: String::from_utf8_lossy(&name.value).into_owned(),
        owner: String::new(),
        pid,
        app,
        x,
        y,
        width,
        height,
    })
}

impl Source for Native {
    fn ready(&self) -> Result<(), Fault> {
        let connection = self.connection.lock().map_err(failed)?;
        connection
            .get_input_focus()
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        Ok(())
    }

    fn displays(&self) -> Result<Vec<Display>, Fault> {
        let connection = self.connection.lock().map_err(failed)?;
        let screen = connection
            .setup()
            .roots
            .get(self.screen)
            .ok_or(Fault::DisplayNotFound)?;
        Ok(vec![Display {
            id: 0,
            x: 0,
            y: 0,
            width: u32::from(screen.width_in_pixels),
            height: u32::from(screen.height_in_pixels),
            scale: 1.0,
            primary: true,
        }])
    }

    fn windows(&self) -> Result<Vec<Window>, Fault> {
        let connection = self.connection.lock().map_err(failed)?;
        let root = self.root(&connection)?;
        let clients = atom(&connection, b"_NET_CLIENT_LIST")?;
        let rows = connection
            .get_property(false, root, clients, AtomEnum::WINDOW, 0, 512)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        let title = atom(&connection, b"_NET_WM_NAME")?;
        let pid_atom = atom(&connection, b"_NET_WM_PID")?;
        rows.value32()
            .into_iter()
            .flatten()
            .map(|id| window(&connection, root, title, pid_atom, id))
            .collect()
    }

    fn capture_display(&self, display: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault> {
        if display != 0 {
            return Err(Fault::DisplayNotFound);
        }
        let connection = self.connection.lock().map_err(failed)?;
        let screen = connection
            .setup()
            .roots
            .get(self.screen)
            .ok_or(Fault::DisplayNotFound)?;
        let image = connection
            .get_image(
                ImageFormat::Z_PIXMAP,
                screen.root,
                0,
                0,
                screen.width_in_pixels,
                screen.height_in_pixels,
                !0,
            )
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        self::pixels(
            &connection,
            &image,
            pixels,
            screen.width_in_pixels,
            screen.height_in_pixels,
        )
    }

    fn capture_window(&self, id: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault> {
        let connection = self.connection.lock().map_err(failed)?;
        let size = connection
            .get_geometry(id)
            .map_err(|_| Fault::WindowNotFound)?
            .reply()
            .map_err(|_| Fault::WindowNotFound)?;
        let image = connection
            .get_image(ImageFormat::Z_PIXMAP, id, 0, 0, size.width, size.height, !0)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        self::pixels(&connection, &image, pixels, size.width, size.height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_metadata_refuses_missing_formats_and_visuals() {
        let owned = crate::display::xvfb::open(&crate::display::Config {
            kind: "xvfb".into(),
            width: 32,
            height: 24,
            dpi: 96,
            window_manager: Some(crate::display::Manager {
                path: "/bin/true".into(),
                args: vec![],
            }),
        })
        .expect("display");
        let (connection, index) =
            super::super::probe::x11::connection(Some(&owned.id)).expect("connection");
        let root = &connection.setup().roots[index];
        let mut image = connection
            .get_image(ImageFormat::Z_PIXMAP, root.root, 0, 0, 1, 1, !0)
            .expect("image")
            .reply()
            .expect("image reply");
        let mut output = Vec::new();
        assert_eq!(pixels(&connection, &image, &mut output, 1, 1), Ok((1, 1)));
        for (depth, visual, reason) in [
            (255, root.root_visual, "missing X11 pixmap format"),
            (root.root_depth, u32::MAX, "missing X11 visual"),
        ] {
            image.depth = depth;
            image.visual = visual;
            assert_eq!(
                pixels(&connection, &image, &mut output, 1, 1),
                Err(Fault::Failed(reason.into()))
            );
        }
    }
}
